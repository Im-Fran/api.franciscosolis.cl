import { SELF, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, seedEntry, seedLegalPage } from '../helpers/db'
import { asEditor } from '../helpers/tokens'

type AuditRow = {
  id: string
  event: string
  actor_email: string | null
  resource_type: string | null
  resource_id: string | null
  ip: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

let headers: Record<string, string>

const call = (method: string, path: string, body?: unknown) =>
  SELF.fetch(`https://cms.internal${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const trail = async (query = '') => (await (await call('GET', `/admin/audit${query}`)).json<{ data: AuditRow[] }>()).data

beforeAll(async () => {
  headers = await asEditor()
})

beforeEach(clearDatabase)

describe('GET /admin/audit', () => {
  it('is empty before anything is written', async () => {
    expect(await trail()).toEqual([])
  })

  it('records one row per editorial write, across every resource', async () => {
    await call('POST', '/admin/content/projects', { title: 'A project' })
    await call('POST', '/admin/legal', { title: 'Privacy', body: '# Privacy' })
    await call('POST', '/admin/email-templates', { name: 'Welcome', subject: 'S', text: 'T' })

    const events = (await trail()).map((row) => row.event)
    expect(events.sort()).toEqual(['content.created', 'email_template.created', 'legal.created'])
  })

  it('names the actor and the resource on every row', async () => {
    const seeded = await seedEntry({ collection: 'projects', slug: 'audited' })
    await call('DELETE', `/admin/content/projects/${seeded.id}`)

    const [row] = await trail()
    expect(row).toMatchObject({
      event: 'content.deleted',
      actor_email: 'fran@franciscosolis.cl',
      resource_type: 'content_entries',
      resource_id: seeded.id,
      metadata: { collection: 'projects', slug: 'audited' },
    })
    expect(row?.created_at).toEqual(expect.any(String))
  })

  it('does not record a read', async () => {
    await call('GET', '/admin/content/projects')
    await call('GET', '/admin/legal')
    await SELF.fetch('https://cms.internal/content/projects')

    expect(await trail()).toEqual([])
  })

  it('does not record a refused write', async () => {
    await call('POST', '/admin/content/projects', { title: '' })
    await call('POST', '/admin/legal', { title: 'No body' })
    await call('DELETE', '/admin/content/projects/nope')

    expect(await trail()).toEqual([])
  })

  it('outlives the resource it describes', async () => {
    const page = await seedLegalPage({ slug: 'gone' })
    await call('DELETE', `/admin/legal/${page.id}`)

    const [row] = await trail()
    expect(row?.event).toBe('legal.deleted')
    expect(row?.resource_id).toBe(page.id)
  })

  it('surfaces the IP the request came from', async () => {
    await SELF.fetch('https://cms.internal/admin/content/projects', {
      method: 'POST',
      headers: { ...headers, 'CF-Connecting-IP': '198.51.100.4' },
      body: JSON.stringify({ title: 'From an IP' }),
    })

    expect((await trail())[0]?.ip).toBe('198.51.100.4')
  })

  it('never carries the caller\'s token', async () => {
    await call('POST', '/admin/content/projects', { title: 'Token check' })

    const body = JSON.stringify(await trail())
    expect(body).not.toContain(headers.Authorization?.replace('Bearer ', ''))
  })

  it('reports a row with no metadata as null rather than failing to parse it', async () => {
    await env.DB.prepare('INSERT INTO audit_logs (id, event, actor_email) VALUES (?, ?, ?)')
      .bind('bare-row', 'content.created', 'fran@franciscosolis.cl')
      .run()

    const [row] = await trail()
    expect(row?.metadata).toBeNull()
    expect(row?.resource_id).toBeNull()
  })

  it('pages with limit and offset', async () => {
    for (const title of ['one', 'two', 'three']) {
      await call('POST', '/admin/content/projects', { title })
    }

    expect(await trail('?limit=2')).toHaveLength(2)
    expect(await trail('?limit=2&offset=2')).toHaveLength(1)
    expect(await trail('?offset=99')).toHaveLength(0)
  })

  it('rejects a limit past the cap and a non-numeric one', async () => {
    expect((await call('GET', '/admin/audit?limit=201')).status).toBe(400)
    expect((await call('GET', '/admin/audit?limit=abc')).status).toBe(400)
    expect((await call('GET', '/admin/audit?offset=-1')).status).toBe(400)
  })

  it('is never cached', async () => {
    expect((await call('GET', '/admin/audit')).headers.get('Cache-Control')).toBe('no-store')
  })
})
