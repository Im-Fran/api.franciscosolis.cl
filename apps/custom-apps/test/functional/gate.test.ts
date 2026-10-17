import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createApp, enrollDevice, panel, panelJson } from '../helpers/api'

describe('the panel gate', () => {
  it('refuses a request with no token', async () => {
    const response = await SELF.fetch('https://api.franciscosolis.cl/v1/me')
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ code: 401, error: 'A Bearer access token is required' })
  })

  it('lets the panel account in', async () => {
    const { status, body } = await panelJson('/v1/me')
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ email: 'fran@franciscosolis.cl', permissions: ['custom-apps:admin'] })
  })

  it('refuses a token minted for another application', async () => {
    const { status, body } = await panelJson('/v1/me', { as: { aud: 'franciscosolis-marketplace' } })
    expect(status).toBe(401)
    expect(body.error).toBe('Invalid access token: the token was not issued for this service')
  })

  it('refuses an address outside the domain, even with the permission', async () => {
    expect((await panel('/v1/me', { as: { email: 'fran@gmail.com' } })).status).toBe(403)
    // A suffix match would let this one through.
    expect((await panel('/v1/me', { as: { email: 'fran@franciscosolis.cl.evil.test' } })).status).toBe(403)
  })

  it('refuses an unverified address', async () => {
    expect((await panel('/v1/me', { as: { email_verified: false } })).status).toBe(403)
  })

  it('refuses a company account without the permission', async () => {
    const { status, body } = await panelJson('/v1/me', { as: { permissions: ['marketplace:editor'] } })
    expect(status).toBe(403)
    expect(body.error).toBe('This account is missing the custom-apps:admin permission')
  })

  it('never accepts an installation token', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    const response = await SELF.fetch('https://api.franciscosolis.cl/v1/me', { headers: { Authorization: `Bearer ${device.access_token}` } })
    expect(response.status).toBe(401)
  })

  it('marks every panel answer as uncacheable', async () => {
    expect((await panel('/v1/companies')).headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('the two front doors', () => {
  it('serves the panel, not ingest, on any host but the ingest one', async () => {
    const created = await createApp()
    const response = await SELF.fetch(`https://api.franciscosolis.cl/custom-apps/v1/${created.id}/status`)
    expect(response.status).toBe(404)
  })

  it('serves ingest, not the panel, on the ingest host', async () => {
    const response = await SELF.fetch('https://ingest.franciscosolis.cl/custom-apps/v1/me')
    expect(response.status).toBe(404)
    const root = await SELF.fetch('https://ingest.franciscosolis.cl/v1/companies')
    expect(root.status).toBe(404)
  })

  it('answers the status document on the panel host without a token', async () => {
    const response = await SELF.fetch('https://api.franciscosolis.cl/')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Record<string, unknown> }
    expect(body.data).toMatchObject({
      ingest_base_url: 'https://ingest.franciscosolis.cl/custom-apps/v1',
      presence_modes: ['ping', 'socket'],
      modules: ['metrics', 'events', 'logs', 'crashes', 'config', 'messages', 'commands', 'updates', 'support'],
      offline_after_intervals: 3,
      timezone: 'America/Santiago',
      release_statuses: ['draft', 'published', 'paused', 'withdrawn'],
      arches: ['x86_64', 'aarch64', 'x86', 'armv7', 'universal', 'any'],
      currencies: ['CLP', 'UF'],
      work_kinds: ['maintenance', 'support', 'development', 'other'],
    })
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=UTF-8')
  })

  it('publishes an OpenAPI document for the panel', async () => {
    const response = await SELF.fetch('https://api.franciscosolis.cl/openapi.json')
    const spec = (await response.json()) as { paths: Record<string, unknown> }
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/v1/companies', '/v1/apps/{appId}/keys', '/v1/installations/{installationId}/metrics']))
    // The ingest surface is documented per app, on its own host — never in the panel's document.
    expect(Object.keys(spec.paths).some((path) => path.includes('enroll'))).toBe(false)
  })
})
