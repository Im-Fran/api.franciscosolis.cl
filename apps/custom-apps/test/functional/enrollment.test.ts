import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { hashToken } from '@/lib/tokens'
import { createApp, enrollDevice, ingest, ingestJson, panelJson } from '../helpers/api'

describe('enrolling a device', () => {
  it('creates an active installation flagged for review, and stores only token hashes', async () => {
    const created = await createApp()
    const { status, body } = await ingestJson(created.id, '/enroll', {
      body: { app_key: created.key.key, device_id: 'pos-0001-serial', platform: 'windows', os_name: 'Windows', os_version: '11', arch: 'x86_64', hostname: 'POS-01', app_version: '2.3.0', alias: 'Caja 1' },
    })
    expect(status).toBe(201)
    expect(body.data).toMatchObject({ token_type: 'Bearer', presence: { mode: 'ping', interval_seconds: 60 }, state: { state: 'active', message: null, until: null } })
    expect(body.data.access_token).toMatch(/^cat_/)
    expect(body.data.refresh_token).toMatch(/^car_/)

    const row = await env.DB.prepare('SELECT * FROM installations WHERE id = ?').bind(body.data.installation_id).first<Record<string, unknown>>()
    expect(row).toMatchObject({ status: 'active', needs_review: 1, alias: 'Caja 1', hostname: 'POS-01', app_version: '2.3.0', channel: 'stable' })
    expect(row!.access_token_hash).toBe(await hashToken(body.data.access_token))
    expect(JSON.stringify(row)).not.toContain(body.data.access_token)

    const audit = await env.DB.prepare('SELECT event, actor_email FROM audit_logs WHERE resource_id = ?').bind(body.data.installation_id).first()
    expect(audit).toEqual({ event: 'installation.enrolled', actor_email: null })
  })

  it('re-enrolls a known device: same installation, new tokens, the panel\'s decisions kept', async () => {
    const created = await createApp()
    const first = await enrollDevice(created.id, created.key.key, { device_id: 'kiosk-serial-42', app_version: '1.0.0' })
    await panelJson(`/v1/installations/${first.installation_id}`, { method: 'PATCH', body: { alias: 'Tótem entrada', channel: 'beta' } })
    await panelJson(`/v1/installations/${first.installation_id}/review`, { method: 'POST' })

    const { status, body } = await ingestJson(created.id, '/enroll', {
      body: { app_key: created.key.key, device_id: 'kiosk-serial-42', platform: 'windows', app_version: '1.1.0', alias: 'ignored' },
    })
    expect(status).toBe(200)
    expect(body.data.installation_id).toBe(first.installation_id)
    expect((await ingest(created.id, '/status', { token: first.access_token })).status).toBe(401)

    const detail = (await panelJson(`/v1/installations/${first.installation_id}`)).body.data
    expect(detail).toMatchObject({ alias: 'Tótem entrada', channel: 'beta', needs_review: false, app_version: '1.1.0', previous_app_version: '1.0.0' })
  })

  it('refuses an unknown key and an unknown app', async () => {
    const created = await createApp()
    expect((await ingest(created.id, '/enroll', { body: { app_key: 'cak_not-a-real-key', device_id: 'device-xyz-1', platform: 'linux' } })).status).toBe(401)
    expect((await ingest(crypto.randomUUID(), '/enroll', { body: { app_key: created.key.key, device_id: 'device-xyz-1', platform: 'linux' } })).status).toBe(404)
    expect((await ingest('nope', '/enroll', { body: { app_key: created.key.key, device_id: 'device-xyz-1', platform: 'linux' } })).status).toBe(404)
  })

  it('refuses a platform outside the list, iOS included', async () => {
    const created = await createApp()
    const { status, body } = await ingestJson(created.id, '/enroll', { body: { app_key: created.key.key, device_id: 'device-ios-1', platform: 'ios' } })
    expect(status).toBe(400)
    expect(body.error).toMatch(/platform/)
  })

  it('is limited per IP', async () => {
    const created = await createApp()
    const statuses: number[] = []
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await ingest(created.id, '/enroll', {
        ip: '192.0.2.200',
        body: { app_key: created.key.key, device_id: `device-flood-${attempt}`, platform: 'linux' },
      })
      statuses.push(response.status)
      if (response.status === 429) {
        expect(response.headers.get('Retry-After')).toBe('60')
      }
    }
    expect(statuses.slice(0, 10).every((status) => status === 201)).toBe(true)
    expect(statuses.slice(10)).toEqual([429, 429])
  })

  it('answers browsers from any origin, without credentials', async () => {
    const created = await createApp({ kind: 'web' })
    const preflight = await ingest(created.id, '/heartbeat', {
      method: 'OPTIONS',
      headers: { Origin: 'https://shop.example.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(preflight.headers.get('Access-Control-Allow-Credentials')).toBeNull()
  })
})

describe('tokens', () => {
  it('refresh once: both rotate, and the old refresh token is dead', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    const { status, body } = await ingestJson(created.id, '/token/refresh', { body: { refresh_token: device.refresh_token } })
    expect(status).toBe(200)
    expect(body.data.installation_id).toBe(device.installation_id)
    expect(body.data.access_token).not.toBe(device.access_token)

    expect((await ingest(created.id, '/status', { token: device.access_token })).status).toBe(401)
    expect((await ingest(created.id, '/status', { token: body.data.access_token })).status).toBe(200)
    const replay = await ingest(created.id, '/token/refresh', { body: { refresh_token: device.refresh_token } })
    expect(replay.status).toBe(401)
    expect(replay.headers.get('WWW-Authenticate')).toContain('invalid_token')
  })

  it('are refused once expired', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    await env.DB.prepare('UPDATE installations SET access_token_expires_at = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000) - 1, device.installation_id).run()
    expect((await ingest(created.id, '/status', { token: device.access_token })).status).toBe(401)
  })

  it('only work for the app they were issued for', async () => {
    const first = await createApp()
    const second = await createApp({ company_id: first.company_id, name: 'Other' })
    const device = await enrollDevice(first.id, first.key.key)
    expect((await ingest(second.id, '/status', { token: device.access_token })).status).toBe(401)
    expect((await ingest(second.id, '/token/refresh', { body: { refresh_token: device.refresh_token } })).status).toBe(401)
  })

  it('are required on every device route', async () => {
    const created = await createApp()
    for (const [path, body] of [['/heartbeat', {}], ['/metrics', { samples: [] }], ['/events', { events: [] }], ['/status', undefined]] as const) {
      const response = await ingest(created.id, path, { body })
      expect(response.status, path).toBe(401)
    }
  })
})

describe('revoking an installation', () => {
  it('kills its tokens at once and keeps its device id out for good', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key, { device_id: 'stolen-tablet-7' })
    const other = await enrollDevice(created.id, created.key.key)

    const { body } = await panelJson(`/v1/installations/${device.installation_id}/revoke`, { method: 'POST', body: { reason: 'Reported stolen' } })
    expect(body.data).toMatchObject({ status: 'revoked', revoked_by: 'fran@franciscosolis.cl', access_token_expires_at: null, connected: false })

    expect((await ingest(created.id, '/heartbeat', { token: device.access_token, body: {} })).status).toBe(401)
    expect((await ingest(created.id, '/token/refresh', { body: { refresh_token: device.refresh_token } })).status).toBe(401)
    const again = await ingestJson(created.id, '/enroll', { body: { app_key: created.key.key, device_id: 'stolen-tablet-7', platform: 'android' } })
    expect(again.status).toBe(403)

    expect((await ingest(created.id, '/heartbeat', { token: other.access_token, body: {} })).status).toBe(200)

    const audit = await env.DB.prepare("SELECT metadata FROM audit_logs WHERE resource_id = ? AND event = 'installation.revoked'").bind(device.installation_id).first<{ metadata: string }>()
    expect(JSON.parse(audit!.metadata)).toMatchObject({ reason: 'Reported stolen', device_id: 'stolen-tablet-7' })
  })
})
