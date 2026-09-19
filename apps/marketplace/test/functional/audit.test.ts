import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, seedProduct } from '../helpers/db'
import { asEditor } from '../helpers/tokens'

const admin = async (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://marketplace.test/admin${path}`, {
    ...init,
    headers: { ...(await asEditor()), 'CF-Connecting-IP': '203.0.113.7', 'User-Agent': 'vitest', ...init.headers },
  })

const json = async <T>(response: Response): Promise<T> => ((await response.json()) as { data: T }).data

describe('GET /admin/audit', () => {
  beforeEach(clearDatabase)

  it('reports every write, newest first', async () => {
    const app = await seedProduct({ slug: 'openbattery' })
    await admin(`/products/${app.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'OpenBattery' }) })
    await admin(`/products/${app.id}/wiki`, { method: 'POST', body: JSON.stringify({ title: 'Installation' }) })

    const data = await json<{ event: string }[]>(await admin('/audit'))

    expect(data.map((row) => row.event)).toEqual(['wiki.created', 'product.updated'])
  })

  it('records who did it and from where', async () => {
    const app = await seedProduct({ slug: 'openbattery' })
    await admin(`/products/${app.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'OpenBattery' }) })

    const [entry] = await json<{ actor_email: string; ip: string }[]>(await admin('/audit'))

    expect(entry.actor_email).toBe('fran@franciscosolis.cl')
    expect(entry.ip).toBe('203.0.113.7')
  })

  /**
   * The trail is read by people chasing "who changed this", so what it records has to be the names
   * they would search by — not an opaque id.
   */
  it('names the fields a patch touched, without echoing their values', async () => {
    const app = await seedProduct({ slug: 'openbattery' })
    await admin(`/products/${app.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ overview_body: 'A draft nobody has seen yet' }),
    })

    const [entry] = await json<{ metadata: Record<string, unknown> }[]>(await admin('/audit'))

    expect(entry.metadata).toMatchObject({ fields: ['overview_body'] })
    expect(JSON.stringify(entry.metadata)).not.toContain('nobody has seen')
  })

  it('never sits in a shared cache', async () => {
    expect((await admin('/audit')).headers.get('Cache-Control')).toBe('no-store')
  })
})
