import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_COMPATIBILITY_ENTRIES } from '@/lib/compatibility'
import { clearDatabase, readAuditLog, seedCompatibility, seedProduct, seedRelease } from '../helpers/db'
import { asEditor } from '../helpers/tokens'

const call = (path: string, init: RequestInit = {}) => SELF.fetch(`https://marketplace.test${path}`, init)

const asAdmin = async (path: string, init: RequestInit = {}) =>
  call(path, { ...init, headers: { ...(await asEditor()), ...init.headers } })

const seedContext = async () => {
  const product = await seedProduct({ slug: 'openbattery', name: 'OpenBattery' })
  const release = await seedRelease({ productId: product.id, version: '2.6.4' })
  return { product, release, base: `/admin/products/${product.id}/releases/${release.id}/compatibility` }
}

type Entry = { id: string; kind: string; name: string; constraint: string | null; position: number }

describe('POST /admin/…/compatibility', () => {
  beforeEach(clearDatabase)

  it('records a requirement and maps the reserved-word column onto the API field', async () => {
    const { base } = await seedContext()

    const response = await asAdmin(base, {
      method: 'POST',
      body: JSON.stringify({ kind: 'runtime', name: 'Java', constraint: '17+' }),
    })
    const { data } = (await response.json()) as { data: Entry }

    expect(response.status).toBe(201)
    expect(data).toMatchObject({ kind: 'runtime', name: 'Java', constraint: '17+', optional: false })
  })

  it('refuses a kind outside the vocabulary', async () => {
    const { base } = await seedContext()

    const response = await asAdmin(base, { method: 'POST', body: JSON.stringify({ kind: 'vibes', name: 'Good' }) })

    // 400 rather than 422: the picklist is schema validation, and the validator answers first.
    expect(response.status).toBe(400)
  })

  /** Two answers to "which Java" is not a requirement, it is a question. */
  it('refuses the same kind and name twice on one release', async () => {
    const { base } = await seedContext()
    const body = JSON.stringify({ kind: 'runtime', name: 'Java', constraint: '17+' })

    expect((await asAdmin(base, { method: 'POST', body })).status).toBe(201)
    expect((await asAdmin(base, { method: 'POST', body })).status).toBe(409)
  })

  it('lets the same kind and name sit on two different releases', async () => {
    const { product, base } = await seedContext()
    const other = await seedRelease({ productId: product.id, version: '2.7.0' })
    const body = JSON.stringify({ kind: 'runtime', name: 'Java', constraint: '17+' })

    expect((await asAdmin(base, { method: 'POST', body })).status).toBe(201)
    const otherBase = `/admin/products/${product.id}/releases/${other.id}/compatibility`
    expect((await asAdmin(otherBase, { method: 'POST', body })).status).toBe(201)
  })

  it('stops at the ceiling rather than letting a list grow without bound', async () => {
    const { product, release, base } = await seedContext()
    for (let index = 0; index < MAX_COMPATIBILITY_ENTRIES; index += 1) {
      await seedCompatibility({ productId: product.id, releaseId: release.id, name: `Thing ${index}` })
    }

    const response = await asAdmin(base, { method: 'POST', body: JSON.stringify({ kind: 'os', name: 'One more' }) })

    expect(response.status).toBe(422)
  })

  it('needs an editor token', async () => {
    const { base } = await seedContext()

    expect((await call(base, { method: 'POST', body: '{}' })).status).toBe(401)
  })

  it('writes the addition onto the audit trail', async () => {
    const { base } = await seedContext()

    await asAdmin(base, { method: 'POST', body: JSON.stringify({ kind: 'os', name: 'macOS' }) })

    expect((await readAuditLog()).map((entry) => entry.event)).toContain('compatibility.created')
  })
})

describe('GET, PATCH and DELETE /admin/…/compatibility', () => {
  beforeEach(clearDatabase)

  it('lists the requirements in the order the editor put them in', async () => {
    const { product, release, base } = await seedContext()
    await seedCompatibility({ productId: product.id, releaseId: release.id, name: 'Second', position: 1 })
    await seedCompatibility({ productId: product.id, releaseId: release.id, name: 'First', position: 0 })

    const { data } = (await (await asAdmin(base)).json()) as { data: Entry[] }

    expect(data.map((entry) => entry.name)).toEqual(['First', 'Second'])
  })

  it('clears a constraint with an explicit null and leaves the rest alone', async () => {
    const { product, release, base } = await seedContext()
    const entry = await seedCompatibility({ productId: product.id, releaseId: release.id, name: 'Java' })

    const { data } = (await (
      await asAdmin(`${base}/${entry.id}`, { method: 'PATCH', body: JSON.stringify({ constraint: null }) })
    ).json()) as { data: Entry }

    expect(data).toMatchObject({ name: 'Java', constraint: null })
  })

  it('reorders without reaching into another release', async () => {
    const { product, release, base } = await seedContext()
    const other = await seedRelease({ productId: product.id, version: '2.7.0' })
    const mine = await seedCompatibility({ productId: product.id, releaseId: release.id, name: 'Mine' })
    const theirs = await seedCompatibility({ productId: product.id, releaseId: other.id, name: 'Theirs', position: 0 })

    await asAdmin(`${base}/reorder`, {
      method: 'POST',
      body: JSON.stringify({ items: [{ id: mine.id, position: 7 }, { id: theirs.id, position: 9 }] }),
    })

    const { data } = (await (await asAdmin(base)).json()) as { data: Entry[] }
    expect(data).toHaveLength(1)
    expect(data[0]?.position).toBe(7)

    const otherBase = `/admin/products/${product.id}/releases/${other.id}/compatibility`
    const theirsNow = (await (await asAdmin(otherBase)).json()) as { data: Entry[] }
    expect(theirsNow.data[0]?.position).toBe(0)
  })

  it('deletes one', async () => {
    const { product, release, base } = await seedContext()
    const entry = await seedCompatibility({ productId: product.id, releaseId: release.id })

    expect((await asAdmin(`${base}/${entry.id}`, { method: 'DELETE' })).status).toBe(204)
    const { data } = (await (await asAdmin(base)).json()) as { data: Entry[] }
    expect(data).toEqual([])
  })

  /** The scoping is a security property: an id from one release is not reachable through another. */
  it('404s an entry reached through the wrong release', async () => {
    const { product, release } = await seedContext()
    const other = await seedRelease({ productId: product.id, version: '2.7.0' })
    const entry = await seedCompatibility({ productId: product.id, releaseId: release.id })

    const path = `/admin/products/${product.id}/releases/${other.id}/compatibility/${entry.id}`
    expect((await asAdmin(path, { method: 'DELETE' })).status).toBe(404)
  })

  it('404s a release reached through the wrong product', async () => {
    const { release } = await seedContext()
    const elsewhere = await seedProduct({ slug: 'elsewhere' })

    const path = `/admin/products/${elsewhere.id}/releases/${release.id}/compatibility`
    expect((await asAdmin(path)).status).toBe(404)
  })
})

describe('the public release detail', () => {
  beforeEach(clearDatabase)

  /**
   * Per release and never per product: a release is exactly where support is added and dropped, and
   * an update that starts requiring macOS 15 is the ordinary case.
   */
  it('carries this release\'s own requirements, not another release\'s', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    const old = await seedRelease({ productId: product.id, version: '1.0.0' })
    const now = await seedRelease({ productId: product.id, version: '2.0.0' })
    await seedCompatibility({ productId: product.id, releaseId: old.id, kind: 'os', name: 'macOS', constraintText: '>= 12.0' })
    await seedCompatibility({ productId: product.id, releaseId: now.id, kind: 'os', name: 'macOS', constraintText: '>= 15.0' })

    const read = async (version: string) =>
      ((await (await call(`/products/openbattery/releases/release/${version}`)).json()) as {
        data: { compatibility: Entry[] }
      }).data.compatibility

    expect((await read('1.0.0'))[0]?.constraint).toBe('>= 12.0')
    expect((await read('2.0.0'))[0]?.constraint).toBe('>= 15.0')
  })

  it('is still cacheable, because it carries no per-caller access block', async () => {
    const product = await seedProduct({ slug: 'openbattery', pricingMode: 'paid', priceAmount: 4990 })
    await seedRelease({ productId: product.id, version: '2.0.0' })

    const response = await call('/products/openbattery/releases/release/2.0.0')
    const payload = (await response.json()) as { data: Record<string, unknown> }

    expect(response.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+$/)
    expect(payload.data).not.toHaveProperty('can_download')
    expect(payload.data).not.toHaveProperty('has_paid')
    expect(payload.data).toMatchObject({ requires_payment: true })
  })
})
