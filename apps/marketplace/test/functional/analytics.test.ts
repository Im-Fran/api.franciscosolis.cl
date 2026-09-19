import { SELF, env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { ALL_RELEASES, MAX_SERIES_DAYS } from '@/lib/analytics'
import { clearDatabase, seedProduct, seedRelease, seedReleaseFile } from '../helpers/db'
import { asEditor } from '../helpers/tokens'

const call = (path: string, init: RequestInit = {}) => SELF.fetch(`https://marketplace.test${path}`, init)

const asAdmin = async (path: string, init: RequestInit = {}) =>
  call(path, { ...init, headers: { ...(await asEditor()), ...init.headers } })

/** One viewer is one IP plus one User-Agent. Two different ones are two different people. */
const viewAs = (viewer: { ip: string; agent: string }, body: unknown = {}) =>
  call('/products/openbattery/views', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': viewer.ip,
      'User-Agent': viewer.agent,
    },
    body: JSON.stringify(body),
  })

const fran = { ip: '203.0.113.7', agent: 'Firefox/1' }

const counters = async (productId: string) => {
  const row = await env.DB.prepare('SELECT view_count, download_count FROM products WHERE id = ?')
    .bind(productId)
    .first<{ view_count: number; download_count: number }>()
  return row ?? { view_count: 0, download_count: 0 }
}

const dailyRows = async (productId: string) => {
  const { results } = await env.DB.prepare(
    'SELECT release_id, day, views, downloads FROM product_daily_stats WHERE product_id = ? ORDER BY release_id',
  )
    .bind(productId)
    .all<{ release_id: string; day: string; views: number; downloads: number }>()
  return results
}

describe('POST /products/:slug/views', () => {
  beforeEach(clearDatabase)

  it('counts a view and answers 204', async () => {
    const product = await seedProduct({ slug: 'openbattery' })

    const response = await viewAs(fran)

    expect(response.status).toBe(204)
    expect((await counters(product.id)).view_count).toBe(1)
  })

  /**
   * Deduplicated in the Cache API rather than in D1: a table would mean a write on every view,
   * deduped or not, plus a purge job this Worker has no cron to run.
   */
  it('does not count the same viewer twice inside the window', async () => {
    const product = await seedProduct({ slug: 'openbattery' })

    await viewAs(fran)
    await viewAs(fran)
    await viewAs(fran)

    expect((await counters(product.id)).view_count).toBe(1)
  })

  it('counts a different browser as a different viewer', async () => {
    const product = await seedProduct({ slug: 'openbattery' })

    await viewAs(fran)
    await viewAs({ ip: fran.ip, agent: 'Safari/2' })

    expect((await counters(product.id)).view_count).toBe(2)
  })

  it('writes the product-wide daily row when no release was named', async () => {
    const product = await seedProduct({ slug: 'openbattery' })

    await viewAs(fran)

    const rows = await dailyRows(product.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ release_id: ALL_RELEASES, views: 1, downloads: 0 })
  })

  /**
   * Two rows, not one. Summing the per-release rows would not give the product total, because a
   * view of the product page itself belongs to no release at all.
   */
  it('writes both the product-wide and the per-release row for a version detail view', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    const release = await seedRelease({ productId: product.id, version: '2.6.4' })

    const response = await viewAs(fran, { version: '2.6.4', channel: 'release' })

    expect(response.status).toBe(204)
    const rows = await dailyRows(product.id)
    expect(rows.map((row) => row.release_id).sort()).toEqual([ALL_RELEASES, release.id].sort())
    expect(rows.every((row) => row.views === 1)).toBe(true)
  })

  it('is a 404 for a draft product, and for a release that was never published', async () => {
    await seedProduct({ slug: 'unannounced', status: 'draft' })
    const product = await seedProduct({ slug: 'openbattery' })
    await seedRelease({ productId: product.id, version: '9.9.9', status: 'draft' })

    expect(
      (await call('/products/unannounced/views', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status,
    ).toBe(404)
    expect((await viewAs(fran, { version: '9.9.9' })).status).toBe(404)
  })

  it('is never cached, unlike the read it sits beside', async () => {
    await seedProduct({ slug: 'openbattery' })

    expect((await viewAs(fran)).headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('a served download', () => {
  beforeEach(clearDatabase)

  it('increments the file, the product, the release and both daily rows', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    const release = await seedRelease({ productId: product.id, version: '2.6.4' })
    const file = await seedReleaseFile({ productId: product.id, releaseId: release.id, filename: 'app.zip' })

    const ticket = (await (
      await call(`/products/openbattery/files/${file.id}/download`, { method: 'POST' })
    ).json()) as { data: { url: string } }
    // The gateway strips the `/marketplace` prefix before this Worker sees the path; a minted
    // URL is the public one, so the test has to strip it the same way.
    const path = new URL(ticket.data.url).pathname.replace(/^\/marketplace/, '')
    expect((await call(path)).status).toBe(200)

    expect((await counters(product.id)).download_count).toBe(1)
    const rows = await dailyRows(product.id)
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.downloads === 1)).toBe(true)

    const releaseRow = await env.DB.prepare('SELECT download_count FROM product_releases WHERE id = ?')
      .bind(release.id)
      .first<{ download_count: number }>()
    expect(releaseRow?.download_count).toBe(1)
  })
})

describe('GET /admin/products/:id/analytics', () => {
  beforeEach(clearDatabase)

  it('fills the days nothing happened on, so a chart has a stable set of points', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    await viewAs(fran)

    const { data } = (await (
      await asAdmin(`/admin/products/${product.id}/analytics`)
    ).json()) as { data: { totals: { views: number }; series: { day: string; views: number }[] } }

    expect(data.totals.views).toBe(1)
    expect(data.series).toHaveLength(30)
    expect(data.series.filter((point) => point.views === 1)).toHaveLength(1)
    expect(data.series.filter((point) => point.views === 0)).toHaveLength(29)
  })

  it('narrows to one release', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    const release = await seedRelease({ productId: product.id, version: '2.6.4' })
    await viewAs(fran, { version: '2.6.4' })

    const { data } = (await (
      await asAdmin(`/admin/products/${product.id}/analytics?release_id=${release.id}`)
    ).json()) as { data: { totals: { views: number } } }

    expect(data.totals.views).toBe(1)
  })

  it('refuses a backwards range and one longer than a year', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    const base = `/admin/products/${product.id}/analytics`

    expect((await asAdmin(`${base}?from=2026-03-10&to=2026-03-01`)).status).toBe(422)
    expect((await asAdmin(`${base}?from=2020-01-01&to=2026-01-01`)).status).toBe(422)
    void MAX_SERIES_DAYS
  })

  it('404s a release reached through the wrong product', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    const elsewhere = await seedProduct({ slug: 'elsewhere' })
    const release = await seedRelease({ productId: elsewhere.id, version: '1.0.0' })

    const response = await asAdmin(`/admin/products/${product.id}/analytics?release_id=${release.id}`)
    expect(response.status).toBe(404)
  })

  it('needs an editor token', async () => {
    const product = await seedProduct({ slug: 'openbattery' })

    expect((await call(`/admin/products/${product.id}/analytics`)).status).toBe(401)
  })
})
