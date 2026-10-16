import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createApp, createCompany, enrollDevice, ingest, panelJson } from '../helpers/api'

describe('apps', () => {
  it('are created with their first key and their ingest addresses', async () => {
    const created = await createApp({ heartbeat_interval_seconds: 30, domain: 'Shop.Andes.CL' })
    expect(created).toMatchObject({
      name: 'POS Andes',
      kind: 'kiosk',
      state: 'active',
      presence_mode: 'ping',
      heartbeat_interval_seconds: 30,
      modules: ['events', 'metrics'],
      domain: 'shop.andes.cl',
      installation_count: 0,
      company: { legal_name: 'Comercial Andes SpA' },
      ingest: {
        base_url: `https://ingest.franciscosolis.cl/custom-apps/v1/${created.id}`,
        sdk_url: `https://ingest.franciscosolis.cl/custom-apps/v1/${created.id}/sdk.js`,
        openapi_url: `https://ingest.franciscosolis.cl/custom-apps/v1/${created.id}/openapi.json`,
      },
    })
    expect(created.key).toMatchObject({ status: 'active', label: 'Initial key' })
    expect(created.key.key).toMatch(/^cak_[A-Za-z0-9_-]{32}$/)
  })

  it('refuse an unknown company, an interval out of range and a presence mode that does not exist', async () => {
    const company = await createCompany()
    expect((await panelJson('/v1/apps', { method: 'POST', body: { company_id: crypto.randomUUID(), name: 'X', kind: 'web' } })).status).toBe(422)
    expect((await panelJson('/v1/apps', { method: 'POST', body: { company_id: company.id, name: 'X', kind: 'web', heartbeat_interval_seconds: 5 } })).status).toBe(400)
    const created = await createApp({ company_id: company.id })
    expect((await panelJson(`/v1/apps/${created.id}`, { method: 'PATCH', body: { presence_mode: 'carrier-pigeon' } })).status).toBe(400)
    expect((await panelJson(`/v1/apps/${created.id}`, { method: 'PATCH', body: { presence_mode: 'socket' } })).body.data.presence_mode).toBe('socket')
  })

  it('validate operating hours', async () => {
    const company = await createCompany()
    const hours = { days: { mon: [{ start: '09:00', end: '18:00' }], sat: [{ start: '10:00', end: '14:00' }] } }
    const created = await createApp({ company_id: company.id, operating_hours: hours })
    expect(created.operating_hours).toEqual({ timezone: 'America/Santiago', ...hours })
    const backwards = { days: { mon: [{ start: '18:00', end: '09:00' }] } }
    expect((await panelJson(`/v1/apps/${created.id}`, { method: 'PATCH', body: { operating_hours: backwards } })).status).toBe(400)
    expect((await panelJson(`/v1/apps/${created.id}`, { method: 'PATCH', body: { operating_hours: { timezone: 'Mars/Olympus', days: {} } } })).status).toBe(400)
  })

  it('are listed with their company and filtered', async () => {
    const company = await createCompany()
    await createApp({ company_id: company.id, name: 'Tótem', kind: 'kiosk' })
    await createApp({ company_id: company.id, name: 'Sitio', kind: 'web' })
    const { body } = await panelJson('/v1/apps?kind=web')
    expect(body.data.map((a: any) => [a.name, a.company.legal_name])).toEqual([['Sitio', 'Comercial Andes SpA']])
    expect((await panelJson(`/v1/apps?company_id=${company.id}`)).body.pagination.total).toBe(2)
    expect((await panelJson('/v1/apps?search=t%C3%B3tem')).body.data.map((a: any) => a.name)).toEqual(['Tótem'])
  })

  it('appear on their company with live counts', async () => {
    const created = await createApp()
    await enrollDevice(created.id, created.key.key)
    const detail = (await panelJson(`/v1/companies/${created.company_id}`)).body.data
    expect(detail.app_count).toBe(1)
    expect(detail.apps[0]).toMatchObject({ id: created.id, installation_count: 1, connected_count: 1 })
  })

  it('cannot be deleted once a device has enrolled', async () => {
    const created = await createApp()
    await enrollDevice(created.id, created.key.key)
    expect((await panelJson(`/v1/apps/${created.id}`, { method: 'DELETE' })).status).toBe(409)
  })

  it('are deleted with their keys while nothing has enrolled', async () => {
    const created = await createApp()
    expect((await panelJson(`/v1/apps/${created.id}`, { method: 'DELETE' })).status).toBe(200)
    const { results } = await env.DB.prepare('SELECT id FROM app_keys WHERE app_id = ?').bind(created.id).all()
    expect(results).toEqual([])
  })

  it('carry their kill switch to every installation', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    const until = new Date(Math.floor(Date.now() / 1000 + 10 * 86_400) * 1000).toISOString()
    const { status, body } = await panelJson(`/v1/apps/${created.id}/status`, {
      method: 'PUT',
      body: { state: 'grace', message: 'Su contrato terminó. Contáctenos para renovar.', until },
    })
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ state: 'grace', state_until: until })

    const answer = (await (await ingest(created.id, '/status', { token: device.access_token })).json()) as any
    expect(answer.data).toMatchObject({ state: 'grace', message: 'Su contrato terminó. Contáctenos para renovar.', until })

    const audit = await env.DB.prepare("SELECT metadata FROM audit_logs WHERE resource_id = ? AND event = 'app.state_changed'").bind(created.id).first<{ metadata: string }>()
    expect(JSON.parse(audit!.metadata)).toMatchObject({ before: { state: 'active' }, after: { state: 'grace' } })
  })
})

describe('app keys', () => {
  it('are listed newest first and shown in full', async () => {
    const created = await createApp()
    const second = (await panelJson(`/v1/apps/${created.id}/keys`, { method: 'POST', body: { label: 'Build 2026' } })).body.data
    const keys = (await panelJson(`/v1/apps/${created.id}/keys`)).body.data
    expect(keys.map((key: any) => key.id)).toContain(second.id)
    expect(keys.every((key: any) => key.key.startsWith('cak_'))).toBe(true)
  })

  it('rotate into a new key, revoking the old one at once', async () => {
    const created = await createApp()
    const { status, body } = await panelJson(`/v1/apps/${created.id}/keys/${created.key.id}/rotate`, { method: 'POST' })
    expect(status).toBe(201)
    expect(body.data.previous).toMatchObject({ id: created.key.id, status: 'revoked', replaced_by: body.data.key.id })
    expect(body.data.key).toMatchObject({ status: 'active', label: 'Initial key' })

    expect((await ingest(created.id, '/enroll', { body: { app_key: created.key.key, device_id: 'device-rotated-old', platform: 'linux' } })).status).toBe(401)
    expect((await ingest(created.id, '/enroll', { body: { app_key: body.data.key.key, device_id: 'device-rotated-new', platform: 'linux' } })).status).toBe(201)
    expect((await panelJson(`/v1/apps/${created.id}/keys/${created.key.id}/rotate`, { method: 'POST' })).status).toBe(409)
  })

  it('stop new enrollments when revoked, without touching enrolled devices', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    expect((await panelJson(`/v1/apps/${created.id}/keys/${created.key.id}/revoke`, { method: 'POST' })).body.data.status).toBe('revoked')
    expect((await ingest(created.id, '/enroll', { body: { app_key: created.key.key, device_id: 'device-after-revoke', platform: 'linux' } })).status).toBe(401)
    expect((await ingest(created.id, '/heartbeat', { token: device.access_token, body: {} })).status).toBe(200)
  })

  it('belong to their app only', async () => {
    const first = await createApp()
    const second = await createApp({ company_id: first.company_id, name: 'Other' })
    expect((await panelJson(`/v1/apps/${second.id}/keys/${first.key.id}/revoke`, { method: 'POST' })).status).toBe(404)
    expect((await ingest(second.id, '/enroll', { body: { app_key: first.key.key, device_id: 'device-cross-app', platform: 'linux' } })).status).toBe(401)
  })

  it('give the SDK its integrity, until no key is left', async () => {
    const created = await createApp({ kind: 'web' })
    const sdk = (await panelJson(`/v1/apps/${created.id}/sdk`)).body.data
    expect(sdk).toMatchObject({ url: created.ingest.sdk_url, available: true, modules: ['events', 'metrics'] })
    expect(sdk.integrity).toMatch(/^sha384-/)
    const served = await ingest(created.id, '/sdk.js')
    expect(served.headers.get('X-Content-Integrity')).toBe(sdk.integrity)

    await panelJson(`/v1/apps/${created.id}/keys/${created.key.id}/revoke`, { method: 'POST' })
    expect((await panelJson(`/v1/apps/${created.id}/sdk`)).body.data).toMatchObject({ available: false, integrity: null })
  })
})
