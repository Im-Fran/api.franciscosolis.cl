import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createApp, enrollDevice, INGEST, panel, panelJson } from '../helpers/api'

type Frame = { type: string; data?: Record<string, any>; error?: string }

/** A device's end of the socket: every frame it receives, and a way to wait for the next of a type. */
const connect = async (appId: string, token: string) => {
  const response = await SELF.fetch(`${INGEST()}/${appId}/socket`, {
    headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}`, 'CF-Connecting-IP': '203.0.113.9' },
  })
  const socket = response.webSocket
  if (!socket) return { response, socket: null as never, next: null as never, nextClose: null as never, frames: [] as Frame[] }
  socket.accept()
  const frames: Frame[] = []
  const waiters: Array<{ type: string; resolve: (frame: Frame) => void }> = []
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data)) as Frame
    frames.push(frame)
    const index = waiters.findIndex((waiter) => waiter.type === frame.type)
    if (index !== -1) waiters.splice(index, 1)[0]!.resolve(frame)
  })
  let closed: { code: number } | null = null
  const closeWaiters: Array<(value: { code: number }) => void> = []
  socket.addEventListener('close', (event) => {
    closed = { code: event.code }
    for (const resolve of closeWaiters.splice(0)) resolve(closed)
  })
  /** The next frame of `type`, including one that already arrived and was not waited for yet. */
  const next = (type: string) => {
    const seen = frames.find((frame) => frame.type === type && !(frame as { taken?: boolean }).taken)
    if (seen) {
      ;(seen as { taken?: boolean }).taken = true
      return Promise.resolve(seen)
    }
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${type} frame`)), 3000)
      waiters.push({
        type,
        resolve: (frame) => {
          clearTimeout(timer)
          ;(frame as { taken?: boolean }).taken = true
          resolve(frame)
        },
      })
    })
  }
  const nextClose = () => (closed ? Promise.resolve(closed) : new Promise<{ code: number }>((resolve) => closeWaiters.push(resolve)))
  return { response, socket, next, frames, nextClose }
}

const socketApp = async (overrides: Record<string, unknown> = {}) => {
  const created = await createApp({ modules: ['metrics', 'commands', 'config'], ...overrides })
  await panel(`/v1/apps/${created.id}`, { method: 'PATCH', body: { presence_mode: 'socket' } })
  const device = await enrollDevice(created.id, created.key.key)
  return { app: created, device }
}

const installationRow = (id: string) =>
  env.DB.prepare('SELECT last_seen_at, socket_connected_at, socket_closed_at, last_ip FROM installations WHERE id = ?').bind(id).first<Record<string, number | string | null>>()

describe('socket presence', () => {
  it('is refused in ping mode, without an upgrade, and without a valid token', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    expect((await connect(created.id, device.access_token)).response.status).toBe(409)
    const { app, device: socketDevice } = await socketApp({ company_id: created.company_id })
    expect((await SELF.fetch(`${INGEST()}/${app.id}/socket`, { headers: { Authorization: `Bearer ${socketDevice.access_token}` } })).status).toBe(426)
    expect((await connect(app.id, 'cat_nope')).response.status).toBe(401)
  })

  it('greets the device with its directives and takes heartbeats down the socket', async () => {
    const { app, device } = await socketApp()
    const connection = await connect(app.id, device.access_token)
    expect(connection.response.status).toBe(101)
    const hello = await connection.next('hello')
    expect(hello.data).toMatchObject({ state: { state: 'active' }, presence: { mode: 'socket' }, commands: [] })
    expect(hello.data!.sync.config_etag).toEqual(expect.any(String))
    expect((await installationRow(device.installation_id))!.socket_connected_at).not.toBeNull()

    connection.socket.send(JSON.stringify({ type: 'heartbeat', app_version: '2.0.0', active_seconds: 5, snapshot: { cpu_percent: 12 } }))
    const ack = await connection.next('heartbeat_ack')
    expect(ack.data).toMatchObject({ state: { state: 'active' }, presence: { mode: 'socket', interval_seconds: 60 } })
    const row = await installationRow(device.installation_id)
    expect(row!.last_seen_at).not.toBeNull()
    expect(row!.last_ip).toBe('203.0.113.9')
    const installation = await panelJson(`/v1/installations/${device.installation_id}`)
    expect(installation.body.data).toMatchObject({ connected: true, socket_connected: true, app_version: '2.0.0', presence_mode: 'socket' })
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM heartbeat_log WHERE installation_id = ?').bind(device.installation_id).first('n')).toBe(1)

    connection.socket.send('not json')
    expect((await connection.next('error')).error).toBe('Messages are JSON')
    connection.socket.send(JSON.stringify({ type: 'reboot' }))
    expect((await connection.next('error')).error).toEqual(expect.any(String))
    connection.socket.close(1000, 'bye')
  })

  it('pushes a new command at once, and takes its acknowledgement down the socket', async () => {
    const { app, device } = await socketApp()
    const connection = await connect(app.id, device.access_token)
    await connection.next('hello')
    connection.socket.send(JSON.stringify({ type: 'heartbeat' }))
    await connection.next('heartbeat_ack')

    const created = await panelJson(`/v1/installations/${device.installation_id}/commands`, { method: 'POST', body: { type: 'reload_config' } })
    const sync = await connection.next('sync')
    expect(sync.data!.commands).toEqual([expect.objectContaining({ id: created.body.data.id, type: 'reload_config' })])

    connection.socket.send(JSON.stringify({ type: 'command_ack', id: created.body.data.id, status: 'succeeded' }))
    expect((await connection.next('command_ack')).data).toEqual({ id: created.body.data.id, outcome: 'recorded' })
    expect((await panelJson(`/v1/installations/${device.installation_id}/commands`)).body.data[0].status).toBe('succeeded')
    connection.socket.close(1000, 'bye')
  })

  it('pushes a change to the app to every open socket', async () => {
    const { app, device } = await socketApp()
    const connection = await connect(app.id, device.access_token)
    await connection.next('hello')
    await panel(`/v1/apps/${app.id}/status`, { method: 'PUT', body: { state: 'maintenance', message: 'Volvemos a las 04:00' } })
    const sync = await connection.next('sync')
    expect(sync.data!.state).toMatchObject({ state: 'maintenance', message: 'Volvemos a las 04:00' })
    connection.socket.close(1000, 'bye')
  })

  it('reads as disconnected the moment the socket closes cleanly', async () => {
    const { app, device } = await socketApp()
    const connection = await connect(app.id, device.access_token)
    await connection.next('hello')
    connection.socket.send(JSON.stringify({ type: 'heartbeat' }))
    await connection.next('heartbeat_ack')
    expect((await panelJson(`/v1/installations/${device.installation_id}`)).body.data.connected).toBe(true)

    connection.socket.close(1000, 'bye')
    await connection.nextClose()
    await expect.poll(async () => (await installationRow(device.installation_id))!.socket_closed_at, { timeout: 3000 }).not.toBeNull()
    const after = await panelJson(`/v1/installations/${device.installation_id}`)
    expect(after.body.data).toMatchObject({ connected: false, socket_connected: false })
    expect((await panelJson(`/v1/apps/${app.id}/installations?connected=true`)).body.pagination.total).toBe(0)
  })

  it('keeps one socket per installation, and closes it when the installation is revoked', async () => {
    const { app, device } = await socketApp()
    const first = await connect(app.id, device.access_token)
    await first.next('hello')
    const second = await connect(app.id, device.access_token)
    await second.next('hello')
    expect((await first.nextClose()).code).toBe(4000)

    await panel(`/v1/installations/${device.installation_id}/revoke`, { method: 'POST' })
    expect((await second.nextClose()).code).toBe(4001)
  })
})
