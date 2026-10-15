import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createApp, enrollDevice, ingest, panelJson } from '../helpers/api'

const setLastSeen = (installationId: string, secondsAgo: number) =>
  env.DB.prepare('UPDATE installations SET last_seen_at = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000) - secondsAgo, installationId).run()

describe("an app's installations", () => {
  it('are filtered by connection, review and status', async () => {
    const created = await createApp()
    const online = await enrollDevice(created.id, created.key.key, { alias: 'Caja 1' })
    const offline = await enrollDevice(created.id, created.key.key, { alias: 'Caja 2' })
    const revoked = await enrollDevice(created.id, created.key.key, { alias: 'Caja 3' })
    await setLastSeen(offline.installation_id, 3600)
    await panelJson(`/v1/installations/${online.installation_id}/review`, { method: 'POST' })
    await panelJson(`/v1/installations/${revoked.installation_id}/revoke`, { method: 'POST' })

    const aliases = async (query: string) =>
      (await panelJson(`/v1/apps/${created.id}/installations${query}`)).body.data.map((row: any) => row.alias).sort()

    expect(await aliases('')).toEqual(['Caja 1', 'Caja 2', 'Caja 3'])
    expect(await aliases('?connected=true')).toEqual(['Caja 1'])
    expect(await aliases('?connected=false')).toEqual(['Caja 2', 'Caja 3'])
    expect(await aliases('?needs_review=true')).toEqual(['Caja 2'])
    expect(await aliases('?status=revoked')).toEqual(['Caja 3'])
    expect(await aliases('?search=caja%201')).toEqual(['Caja 1'])
  })

  it('show on the app with their counts', async () => {
    const created = await createApp()
    await enrollDevice(created.id, created.key.key)
    const second = await enrollDevice(created.id, created.key.key)
    await setLastSeen(second.installation_id, 3600)
    expect((await panelJson(`/v1/apps/${created.id}`)).body.data).toMatchObject({ installation_count: 2, connected_count: 1, needs_review_count: 2 })
  })

  it('answer 404 through the wrong ids', async () => {
    expect((await panelJson(`/v1/installations/${crypto.randomUUID()}`)).status).toBe(404)
    expect((await panelJson(`/v1/apps/${crypto.randomUUID()}/installations`)).status).toBe(404)
  })
})

describe('the overview', () => {
  it('counts the fleet, the apps by state and what waits for review', async () => {
    const created = await createApp()
    await panelJson(`/v1/apps/${created.id}/status`, { method: 'PUT', body: { state: 'maintenance' } })
    await createApp({ company_id: created.company_id, name: 'Second' })
    const first = await enrollDevice(created.id, created.key.key)
    const second = await enrollDevice(created.id, created.key.key)
    await setLastSeen(second.installation_id, 3600)
    await panelJson(`/v1/installations/${first.installation_id}/review`, { method: 'POST' })

    const { body } = await panelJson('/v1/overview')
    expect(body.data.installations).toEqual({ total: 2, active: 2, connected: 1, needs_review: 1, revoked: 0 })
    expect(body.data.apps).toEqual({ total: 2, by_state: { active: 1, grace: 0, maintenance: 1, suspended: 0 } })
    expect(body.data.companies.total).toBe(1)
    expect(body.data.recent_installations).toHaveLength(2)
    expect(body.data.needs_review.map((row: any) => row.id)).toEqual([second.installation_id])
    expect(body.data.needs_review[0].app).toEqual({ id: created.id, name: 'POS Andes' })
  })

  it('is all zeros on an empty panel', async () => {
    const { body } = await panelJson('/v1/overview')
    expect(body.data.installations.total).toBe(0)
    expect(body.data.apps.total).toBe(0)
  })
})

describe('the audit trail', () => {
  it('is append-only in the database itself', async () => {
    const created = await createApp()
    await expect(env.DB.prepare('UPDATE audit_logs SET event = ? WHERE resource_id = ?').bind('tampered', created.id).run()).rejects.toThrow(/append-only/)
    await expect(env.DB.prepare('DELETE FROM audit_logs WHERE resource_id = ?').bind(created.id).run()).rejects.toThrow(/append-only/)
  })

  it('is read newest first and filtered', async () => {
    const created = await createApp()
    await panelJson(`/v1/apps/${created.id}`, { method: 'PATCH', body: { name: 'POS Andes 2' } })
    const { body } = await panelJson(`/v1/audit-log?resource_type=app&resource_id=${created.id}`)
    expect(body.data.map((row: any) => row.event)).toEqual(['app.updated', 'app.created', 'app_key.created'])
    expect(body.data[0]).toMatchObject({ actor_email: 'fran@franciscosolis.cl', metadata: { before: { name: 'POS Andes' }, after: { name: 'POS Andes 2' } } })

    const prefixed = await panelJson(`/v1/audit-log?event=app_key.&resource_id=${created.id}`)
    expect(prefixed.body.data.map((row: any) => row.event)).toEqual(['app_key.created'])
  })

  it('records what a device did with no actor', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    const { body } = await panelJson(`/v1/audit-log?resource_id=${device.installation_id}`)
    expect(body.data[0]).toMatchObject({ event: 'installation.enrolled', actor_email: null, resource_type: 'installation' })
  })
})

describe('the documents a client app is given', () => {
  it('describe only the modules the app has, relative to its own base URL', async () => {
    const created = await createApp({ modules: ['events'] })
    const response = await ingest(created.id, '/openapi.json')
    expect(response.status).toBe(200)
    const spec = (await response.json()) as { servers: Array<{ url: string }>; paths: Record<string, Record<string, { parameters?: Array<{ name: string }> }>> }
    expect(spec.servers).toEqual([{ url: created.ingest.base_url }])
    expect(Object.keys(spec.paths).sort()).toEqual(['/enroll', '/events', '/heartbeat', '/sdk.js', '/status', '/token/refresh'])
    expect(JSON.stringify(spec.paths)).not.toContain('"appId"')
  })

  it('serve the SDK with a validator, answering 304 to a cache that has it', async () => {
    const created = await createApp({ kind: 'web' })
    const first = await ingest(created.id, '/sdk.js')
    expect(first.status).toBe(200)
    expect(first.headers.get('Content-Type')).toBe('text/javascript; charset=UTF-8')
    expect(first.headers.get('Cache-Control')).toBe('public, max-age=300')
    const script = await first.text()
    expect(script).toContain(created.key.key)
    const etag = first.headers.get('ETag')!
    const again = await ingest(created.id, '/sdk.js', { headers: { 'If-None-Match': etag } })
    expect(again.status).toBe(304)
  })

  it('change the SDK when the app changes', async () => {
    const created = await createApp({ kind: 'web' })
    const before = await (await ingest(created.id, '/sdk.js')).text()
    await panelJson(`/v1/apps/${created.id}`, { method: 'PATCH', body: { modules: ['metrics'] } })
    const after = await (await ingest(created.id, '/sdk.js')).text()
    expect(after).not.toBe(before)
    expect(after).toContain('"modules":["metrics"]')
  })

  it('refuse an oversized body before reading it', async () => {
    const created = await createApp()
    const response = await ingest(created.id, '/enroll', { body: 'x'.repeat(300 * 1024) })
    expect(response.status).toBe(413)
  })
})

describe('action routes', () => {
  it('take an optional body, or none at all', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    expect((await panelJson(`/v1/apps/${created.id}/keys`, { method: 'POST' })).status).toBe(201)
    expect((await panelJson(`/v1/apps/${created.id}/keys`, { method: 'POST', body: '{"label":"CI"}' })).body.data.label).toBe('CI')
    expect((await panelJson(`/v1/apps/${created.id}/keys`, { method: 'POST', body: '{not json' })).status).toBe(400)
    expect((await panelJson(`/v1/installations/${device.installation_id}/revoke`, { method: 'POST' })).body.data.status).toBe('revoked')
  })
})
