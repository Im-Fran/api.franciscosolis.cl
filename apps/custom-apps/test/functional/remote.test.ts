import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { runScheduled } from '@/services/maintenance'
import { createApp, enrollDevice, ingest, ingestJson, panel, panelJson } from '../helpers/api'

const ALL_MODULES = ['metrics', 'events', 'logs', 'crashes', 'config', 'messages', 'commands']

const fleet = async (overrides: Record<string, unknown> = {}) => {
  const created = await createApp({ modules: ALL_MODULES, ...overrides })
  const device = await enrollDevice(created.id, created.key.key)
  return { app: created, device }
}

const heartbeat = async (appId: string, token: string) => (await ingestJson(appId, '/heartbeat', { token, body: {} })).body.data

describe('commands', () => {
  it('are handed over in every heartbeat answer until the device acknowledges them', async () => {
    const { app, device } = await fleet()
    const created = await panelJson(`/v1/installations/${device.installation_id}/commands`, { method: 'POST', body: { type: 'clear_cache', payload: { scope: 'images' } } })
    expect(created.status).toBe(201)
    expect(created.body.data).toMatchObject({ type: 'clear_cache', status: 'pending', payload: { scope: 'images' }, created_by: 'fran@franciscosolis.cl' })

    const first = await heartbeat(app.id, device.access_token)
    expect(first.commands).toEqual([expect.objectContaining({ id: created.body.data.id, type: 'clear_cache', payload: { scope: 'images' } })])
    // The answer could have been lost: it is repeated until acknowledged.
    expect((await heartbeat(app.id, device.access_token)).commands).toHaveLength(1)

    const listed = await panelJson(`/v1/installations/${device.installation_id}/commands`)
    expect(listed.body.data[0]).toMatchObject({ status: 'delivered' })
    expect(listed.body.data[0].delivered_at).not.toBeNull()

    const ack = await ingestJson(app.id, `/commands/${created.body.data.id}/ack`, { token: device.access_token, body: { status: 'succeeded', result: { freed_bytes: 1024 } } })
    expect(ack.status).toBe(200)
    // Twice is harmless.
    expect((await ingest(app.id, `/commands/${created.body.data.id}/ack`, { token: device.access_token, body: { status: 'succeeded' } })).status).toBe(200)
    expect((await heartbeat(app.id, device.access_token)).commands).toEqual([])
    const done = await panelJson(`/v1/installations/${device.installation_id}/commands`)
    expect(done.body.data[0]).toMatchObject({ status: 'succeeded', result: { freed_bytes: 1024 } })

    const audit = await env.DB.prepare("SELECT metadata FROM audit_logs WHERE resource_id = ? AND event = 'command.created'").bind(device.installation_id).first<{ metadata: string }>()
    expect(JSON.parse(audit!.metadata)).toMatchObject({ type: 'clear_cache', command_id: created.body.data.id })
  })

  it('are only ever acknowledged by the installation they were sent to', async () => {
    const { app, device } = await fleet()
    const other = await enrollDevice(app.id, app.key.key)
    const created = await panelJson(`/v1/installations/${device.installation_id}/commands`, { method: 'POST', body: { type: 'reload_config' } })
    expect((await ingest(app.id, `/commands/${created.body.data.id}/ack`, { token: other.access_token, body: { status: 'succeeded' } })).status).toBe(404)
  })

  it('can be cancelled, after which the device cannot acknowledge them', async () => {
    const { app, device } = await fleet()
    const created = await panelJson(`/v1/installations/${device.installation_id}/commands`, { method: 'POST', body: { type: 'upload_logs' } })
    const cancelled = await panelJson(`/v1/commands/${created.body.data.id}/cancel`, { method: 'POST' })
    expect(cancelled.body.data).toMatchObject({ status: 'cancelled', cancelled_by: 'fran@franciscosolis.cl' })
    expect((await panelJson(`/v1/commands/${created.body.data.id}/cancel`, { method: 'POST' })).status).toBe(409)
    expect((await heartbeat(app.id, device.access_token)).commands).toEqual([])
    expect((await ingest(app.id, `/commands/${created.body.data.id}/ack`, { token: device.access_token, body: { status: 'succeeded' } })).status).toBe(409)
  })

  it('expire on the cron and are never handed over once expired', async () => {
    const { app, device } = await fleet()
    const created = await panelJson(`/v1/installations/${device.installation_id}/commands`, { method: 'POST', body: { type: 'check_update', expires_in_seconds: 60 } })
    await env.DB.prepare('UPDATE commands SET expires_at = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000) - 1, created.body.data.id).run()
    expect((await heartbeat(app.id, device.access_token)).commands).toEqual([])
    const result = await runScheduled(env, new Date(Date.UTC(2026, 9, 16, 12, 10)))
    expect(result.expired_commands).toBe(1)
    expect((await panelJson(`/v1/installations/${device.installation_id}/commands`)).body.data[0].status).toBe('expired')
  })

  it('refuse what the app or the device cannot take', async () => {
    const { app, device } = await fleet({ kind: 'desktop' })
    const send = (body: Record<string, unknown>, installationId = device.installation_id) =>
      panelJson(`/v1/installations/${installationId}/commands`, { method: 'POST', body })
    expect((await send({ type: 'restart_device' })).status).toBe(409)
    expect((await send({ type: 'screenshot' })).status).toBe(409)
    expect((await send({ type: 'format_disk' })).status).toBe(400)

    const without = await createApp({ company_id: app.company_id, modules: ['metrics'] })
    const plain = await enrollDevice(without.id, without.key.key)
    expect((await send({ type: 'reload_config' }, plain.installation_id)).status).toBe(409)
    expect((await heartbeat(without.id, plain.access_token)).commands).toEqual([])

    await panel(`/v1/installations/${device.installation_id}/revoke`, { method: 'POST' })
    expect((await send({ type: 'reload_config' })).status).toBe(409)
  })
})

describe('screenshots', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

  const askForOne = async () => {
    const { app, device } = await fleet()
    await panel(`/v1/apps/${app.id}`, { method: 'PATCH', body: { screenshots_enabled: true } })
    const command = await panelJson(`/v1/installations/${device.installation_id}/commands`, { method: 'POST', body: { type: 'screenshot' } })
    expect(command.status).toBe(201)
    return { app, device, command: command.body.data }
  }

  const upload = (appId: string, token: string, commandId: string, body: BodyInit = PNG, type = 'image/png') =>
    ingest(appId, `/commands/${commandId}/screenshot`, { token, body, headers: { 'Content-Type': type } })

  it('are uploaded in answer to a command, stored privately and served to the panel only', async () => {
    const { app, device, command } = await askForOne()
    const response = await upload(app.id, device.access_token, command.id)
    expect(response.status).toBe(201)

    const list = await panelJson(`/v1/installations/${device.installation_id}/screenshots`)
    expect(list.body.data).toEqual([expect.objectContaining({ command_id: command.id, content_type: 'image/png', size_bytes: PNG.byteLength })])
    expect((await panelJson(`/v1/installations/${device.installation_id}/commands`)).body.data[0]).toMatchObject({ status: 'succeeded', result: { screenshot_id: list.body.data[0].id } })

    const image = await panel(list.body.data[0].image_path)
    expect(image.status).toBe(200)
    expect(image.headers.get('Content-Type')).toBe('image/png')
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG)
    expect((await panel(list.body.data[0].image_path, { as: { permissions: [] } })).status).toBe(403)

    // The command is done: a second upload is refused.
    expect((await upload(app.id, device.access_token, command.id)).status).toBe(409)
  })

  it('can be deleted, image and record', async () => {
    const { app, device, command } = await askForOne()
    await upload(app.id, device.access_token, command.id)
    const [shot] = (await panelJson(`/v1/installations/${device.installation_id}/screenshots`)).body.data
    const objects = await env.SCREENSHOTS.list({ prefix: `screenshots/${app.id}/` })
    expect(objects.objects).toHaveLength(1)
    expect((await panelJson(`/v1/screenshots/${shot.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await env.SCREENSHOTS.list({ prefix: `screenshots/${app.id}/` })).objects).toHaveLength(0)
    expect((await panel(shot.image_path)).status).toBe(404)
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE event = 'screenshot.deleted' AND resource_id = ?").bind(device.installation_id).first('n')).toBe(1)
  })

  it('are refused when turned off for the device after the command was sent, or in the wrong format', async () => {
    const { app, device, command } = await askForOne()
    expect((await upload(app.id, device.access_token, command.id, 'hello', 'text/plain')).status).toBe(415)
    await panel(`/v1/installations/${device.installation_id}`, { method: 'PATCH', body: { screenshots_enabled: false } })
    expect((await upload(app.id, device.access_token, command.id)).status).toBe(403)
    expect((await panelJson(`/v1/installations/${device.installation_id}/commands`, { method: 'POST', body: { type: 'screenshot' } })).status).toBe(409)
  })

  it('may be larger than a JSON body, up to their own limit', async () => {
    const { app, device, command } = await askForOne()
    const big = new Uint8Array(400 * 1024)
    big.set(PNG)
    expect((await upload(app.id, device.access_token, command.id, big)).status).toBe(201)
  })
})

describe('flags and remote config', () => {
  it('resolve per device, the most specific scope winning', async () => {
    const { app, device } = await fleet()
    const beta = await enrollDevice(app.id, app.key.key, { channel: 'beta' })
    const set = (body: Record<string, unknown>) => panelJson(`/v1/apps/${app.id}/flags`, { method: 'POST', body })
    expect((await set({ key: 'new-checkout', value: false })).status).toBe(201)
    expect((await set({ key: 'new-checkout', value: true, scope: 'channel', scope_value: 'beta' })).status).toBe(201)
    expect((await set({ key: 'theme', value: 'dark', scope: 'installation', scope_value: device.installation_id })).status).toBe(201)
    expect((await set({ key: 'new-checkout', value: true })).status).toBe(409)
    expect((await set({ key: 'x', value: 1, scope: 'channel', scope_value: 'nightly' })).status).toBe(422)
    expect((await set({ key: 'x', value: 1, scope: 'installation', scope_value: crypto.randomUUID() })).status).toBe(422)
    expect((await set({ key: 'Not A Key', value: 1 })).status).toBe(400)

    const stable = await ingestJson(app.id, '/config', { token: device.access_token })
    expect(stable.body.data).toEqual({ flags: { 'new-checkout': false, theme: 'dark' }, config: {}, config_version: 0 })
    const onBeta = await ingestJson(app.id, '/config', { token: beta.access_token })
    expect(onBeta.body.data.flags).toEqual({ 'new-checkout': true })
  })

  it('answer 304 to an ETag that still holds, and the heartbeat says when it no longer does', async () => {
    const { app, device } = await fleet()
    const first = await ingest(app.id, '/config', { token: device.access_token })
    const etag = first.headers.get('ETag')!
    expect((await heartbeat(app.id, device.access_token)).sync.config_etag).toBe(etag)
    expect((await ingest(app.id, '/config', { token: device.access_token, headers: { 'If-None-Match': etag } })).status).toBe(304)

    await panel(`/v1/apps/${app.id}/config`, { method: 'PUT', body: { document: { welcome: 'Hola' } } })
    const sync = (await heartbeat(app.id, device.access_token)).sync
    expect(sync.config_etag).not.toBe(etag)
    const second = await ingestJson(app.id, '/config', { token: device.access_token, headers: { 'If-None-Match': etag } })
    expect(second.status).toBe(200)
    expect(second.body.data).toMatchObject({ config: { welcome: 'Hola' }, config_version: 1 })
    expect(second.response.headers.get('ETag')).toBe(sync.config_etag)
  })

  it('validate the document against the app schema, and refuse a schema they cannot enforce', async () => {
    const { app } = await fleet()
    const put = (body: Record<string, unknown>) => panelJson(`/v1/apps/${app.id}/config`, { method: 'PUT', body })
    const schema = { type: 'object', required: ['currency'], properties: { currency: { enum: ['CLP', 'UF'] }, tip: { type: 'integer', minimum: 0, maximum: 30 } }, additionalProperties: false }
    expect((await put({ document: { currency: 'CLP', tip: 10 }, schema })).status).toBe(200)
    const invalid = await put({ document: { currency: 'USD', tip: 50, extra: true } })
    expect(invalid.status).toBe(422)
    expect(invalid.body.issues).toEqual(expect.arrayContaining(['#/currency: must be one of "CLP", "UF"', '#/tip: must be at most 30', '#/extra: is not an allowed property']))
    expect((await put({ document: {}, schema: { type: 'object', oneOf: [] } })).status).toBe(422)
    expect((await put({ document: { currency: 'UF' }, base_version: 0 })).status).toBe(409)

    const saved = await put({ document: { currency: 'UF' }, base_version: 1, note: 'UF for the north branch' })
    expect(saved.body.data).toMatchObject({ version: 2, document: { currency: 'UF' }, note: 'UF for the north branch', schema })
  })

  it('keep every version, and restore an old one as the next', async () => {
    const { app } = await fleet()
    await panel(`/v1/apps/${app.id}/config`, { method: 'PUT', body: { document: { a: 1 } } })
    await panel(`/v1/apps/${app.id}/config`, { method: 'PUT', body: { document: { a: 2 } } })
    const restored = await panelJson(`/v1/apps/${app.id}/config/history/1/restore`, { method: 'POST' })
    expect(restored.body.data).toMatchObject({ version: 3, document: { a: 1 }, note: 'Restored version 1' })
    const history = await panelJson(`/v1/apps/${app.id}/config/history`)
    expect(history.body.data.map((row: { version: number }) => row.version)).toEqual([3, 2, 1])
    expect((await panelJson(`/v1/apps/${app.id}/config/history/9/restore`, { method: 'POST' })).status).toBe(404)
  })

  it('are not served to an app without the config module', async () => {
    const created = await createApp({ modules: ['metrics'] })
    const device = await enrollDevice(created.id, created.key.key)
    expect((await ingest(created.id, '/config', { token: device.access_token })).status).toBe(403)
    expect((await heartbeat(created.id, device.access_token)).sync).toEqual({ config_etag: null, messages_etag: null, log_level: null })
  })
})

describe('messages', () => {
  it('reach the devices they are aimed at while they run, and count who confirmed them', async () => {
    const { app, device } = await fleet()
    const other = await enrollDevice(app.id, app.key.key)
    const everyone = await panelJson(`/v1/apps/${app.id}/messages`, { method: 'POST', body: { title: 'Mantención el sábado', body: 'De 02:00 a 04:00.', severity: 'warning' } })
    expect(everyone.status).toBe(201)
    await panelJson(`/v1/apps/${app.id}/messages`, { method: 'POST', body: { title: 'Solo tótem', body: 'Hola', display: 'modal', severity: 'critical', scope: 'installation', scope_value: device.installation_id } })
    await panelJson(`/v1/apps/${app.id}/messages`, { method: 'POST', body: { title: 'Mañana', body: '…', starts_at: new Date(Date.now() + 86_400_000).toISOString() } })

    const mine = await ingestJson(app.id, '/messages', { token: device.access_token })
    expect(mine.body.data.map((message: { title: string }) => message.title)).toEqual(['Solo tótem', 'Mantención el sábado'])
    const theirs = await ingestJson(app.id, '/messages', { token: other.access_token })
    expect(theirs.body.data.map((message: { title: string }) => message.title)).toEqual(['Mantención el sábado'])

    const before = (await heartbeat(app.id, device.access_token)).sync.messages_etag
    expect((await ingestJson(app.id, `/messages/${everyone.body.data.id}/seen`, { token: device.access_token, body: {} })).status).toBe(200)
    await ingest(app.id, `/messages/${everyone.body.data.id}/seen`, { token: device.access_token, body: {} })
    expect((await heartbeat(app.id, device.access_token)).sync.messages_etag).not.toBe(before)
    const seen = (await ingestJson(app.id, '/messages', { token: device.access_token })).body.data.find((message: { id: string }) => message.id === everyone.body.data.id)
    expect(seen.seen).toBe(true)

    const listed = await panelJson(`/v1/apps/${app.id}/messages?status=active`)
    expect(listed.body.data.find((message: { id: string }) => message.id === everyone.body.data.id)).toMatchObject({ seen_count: 1, status: 'active' })
    expect((await panelJson(`/v1/apps/${app.id}/messages?status=scheduled`)).body.data).toHaveLength(1)
    const receipts = await panelJson(`/v1/messages/${everyone.body.data.id}/receipts`)
    expect(receipts.body.data).toEqual([expect.objectContaining({ installation_id: device.installation_id })])
  })

  it('stop when ended, and refuse a window that ends before it starts', async () => {
    const { app, device } = await fleet()
    const created = await panelJson(`/v1/apps/${app.id}/messages`, { method: 'POST', body: { title: 'Aviso', body: 'Texto', starts_at: new Date(Date.now() - 3_600_000).toISOString() } })
    expect((await ingestJson(app.id, '/messages', { token: device.access_token })).body.data).toHaveLength(1)
    expect((await panelJson(`/v1/messages/${created.body.data.id}`, { method: 'PATCH', body: { ends_at: new Date(Date.now() - 86_400_000 * 2).toISOString() } })).status).toBe(400)
    await panel(`/v1/messages/${created.body.data.id}`, { method: 'PATCH', body: { ends_at: new Date(Date.now() - 1000).toISOString() } })
    expect((await ingestJson(app.id, '/messages', { token: device.access_token })).body.data).toEqual([])
    expect((await panelJson(`/v1/messages/${created.body.data.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await ingest(app.id, `/messages/${created.body.data.id}/seen`, { token: device.access_token, body: {} })).status).toBe(404)
  })

  it('cannot be created for an app without the module', async () => {
    const created = await createApp({ modules: [] })
    expect((await panelJson(`/v1/apps/${created.id}/messages`, { method: 'POST', body: { title: 'x', body: 'y' } })).status).toBe(409)
  })
})

describe('the per-app document', () => {
  it('lists the operations of the modules the app has, and the socket only in socket mode', async () => {
    const created = await createApp({ modules: ['config'] })
    const paths = Object.keys(((await ingestJson(created.id, '/openapi.json')).body as { paths: Record<string, unknown> }).paths)
    expect(paths).toEqual(expect.arrayContaining(['/heartbeat', '/config']))
    expect(paths).not.toEqual(expect.arrayContaining(['/socket']))
    expect(paths.some((path) => path.startsWith('/commands') || path.startsWith('/messages') || path === '/logs')).toBe(false)
    await panel(`/v1/apps/${created.id}`, { method: 'PATCH', body: { presence_mode: 'socket' } })
    const socketPaths = Object.keys(((await ingestJson(created.id, '/openapi.json')).body as { paths: Record<string, unknown> }).paths)
    expect(socketPaths).toContain('/socket')
  })
})
