import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, readAuditLog, seedProduct, seedRelease } from '../helpers/db'
import { asEditor } from '../helpers/tokens'

const admin = async (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://marketplace.test/admin${path}`, { ...init, headers: { ...(await asEditor()), ...init.headers } })

const json = async <T>(response: Response): Promise<T> => ((await response.json()) as { data: T }).data

describe('POST /admin/products/:productId/releases', () => {
  beforeEach(clearDatabase)

  const post = (productId: string, payload: Record<string, unknown>) =>
    admin(`/products/${productId}/releases`, { method: 'POST', body: JSON.stringify(payload) })

  it('adds a release note with its store links', async () => {
    const app = await seedProduct({ slug: 'openbattery' })

    const response = await post(app.id, {
      version: '2.6.4',
      title: 'Full 1.21.11 support',
      body: '- Added full support for Minecraft 1.21.11',
      status: 'published',
      released_at: '2026-02-01T00:00:00Z',
      links: [
        { kind: 'github', url: 'https://github.com/example/openbattery/releases/tag/2.6.4' },
        { kind: 'play_store', url: 'https://play.google.com/store/apps/details?id=x', label: 'Get it on Google Play' },
      ],
    })

    expect(response.status).toBe(201)
    const data = await json<Record<string, unknown>>(response)
    expect(data.version).toBe('2.6.4')
    expect(data.released_at).toBe('2026-02-01T00:00:00.000Z')
    expect(data.links).toHaveLength(2)
  })

  /**
   * An undated release sorts below every dated one, so publishing without a date is dated now
   * rather than left null — which is never what "publish this release" meant.
   */
  it('dates a release published with no date of its own', async () => {
    const app = await seedProduct({ slug: 'openbattery' })

    const data = await json<{ released_at: string | null }>(await post(app.id, {
      version: '1.0.0',
      title: 'First',
      status: 'published',
    }))

    expect(data.released_at).not.toBeNull()
  })

  it('leaves a draft undated, because a draft is not a release yet', async () => {
    const app = await seedProduct({ slug: 'openbattery' })

    const data = await json<{ released_at: string | null }>(await post(app.id, { version: '1.0.0', title: 'First' }))

    expect(data.released_at).toBeNull()
  })

  it('refuses a version that already exists in the product, with a 409', async () => {
    const app = await seedProduct({ slug: 'openbattery' })
    await post(app.id, { version: '1.0.0', title: 'First' })

    const response = await post(app.id, { version: '1.0.0', title: 'Again' })

    expect(response.status).toBe(409)
  })

  /** The same version number in two different products is two different releases. */
  it('allows the same version in a different product', async () => {
    const one = await seedProduct({ slug: 'one' })
    const two = await seedProduct({ slug: 'two' })
    await post(one.id, { version: '1.0.0', title: 'First' })

    expect((await post(two.id, { version: '1.0.0', title: 'First' })).status).toBe(201)
  })

  /** A version is a path segment on the public route, so it may not carry a slash or a space. */
  it.each(['1.0 rc1', 'v1/2', '   '])('refuses %j as a version', async (version) => {
    const app = await seedProduct({ slug: 'openbattery' })

    expect((await post(app.id, { version, title: 'X' })).status).toBe(400)
  })

  it.each(['v3', '2026.1', '1.0-beta', '2.6.4'])('accepts %s, because versioning is not only semver', async (version) => {
    const app = await seedProduct({ slug: 'openbattery' })

    expect((await post(app.id, { version, title: 'X' })).status).toBe(201)
  })

  it('answers 404 when the product does not exist', async () => {
    expect((await post(crypto.randomUUID(), { version: '1.0.0', title: 'X' })).status).toBe(404)
  })

  it('writes an audit row naming the product and the version', async () => {
    const app = await seedProduct({ slug: 'openbattery' })
    await post(app.id, { version: '1.0.0', title: 'First' })

    const [entry] = await readAuditLog()
    expect(entry?.event).toBe('release.created')
    expect(entry?.metadata).toMatchObject({ product: 'openbattery', version: '1.0.0' })
  })
})

describe('GET /admin/products/:productId/releases', () => {
  beforeEach(clearDatabase)

  it('shows drafts, which the public tab never does', async () => {
    const app = await seedProduct({ slug: 'openbattery' })
    await seedRelease({ productId: app.id, version: '2.0.0-rc1', status: 'draft' })
    await seedRelease({ productId: app.id, version: '1.0.0', status: 'published' })

    const data = await json<{ version: string }[]>(await admin(`/products/${app.id}/releases`))

    expect(data.map((row) => row.version).sort()).toEqual(['1.0.0', '2.0.0-rc1'])
  })

  /** Scoping every route by product is what stops one page's ids reaching through another's. */
  it('does not list another product\'s releases', async () => {
    const mine = await seedProduct({ slug: 'mine' })
    const theirs = await seedProduct({ slug: 'theirs' })
    await seedRelease({ productId: theirs.id, version: '9.9.9' })

    expect(await json<unknown[]>(await admin(`/products/${mine.id}/releases`))).toEqual([])
  })
})

describe('PATCH and DELETE on a release', () => {
  beforeEach(clearDatabase)

  it('updates a release and leaves omitted fields alone', async () => {
    const app = await seedProduct({ slug: 'openbattery' })
    const release = await seedRelease({ productId: app.id, version: '1.0.0', title: 'First', body: 'Notes' })

    const data = await json<Record<string, unknown>>(
      await admin(`/products/${app.id}/releases/${release.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: 'First release' }),
      }),
    )

    expect(data.title).toBe('First release')
    expect(data.body).toBe('Notes')
  })

  it('refuses to reach a release through the wrong product', async () => {
    const mine = await seedProduct({ slug: 'mine' })
    const theirs = await seedProduct({ slug: 'theirs' })
    const release = await seedRelease({ productId: theirs.id, version: '9.9.9' })

    const response = await admin(`/products/${mine.id}/releases/${release.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Hijacked' }),
    })

    expect(response.status).toBe(404)
  })

  it('deletes a release', async () => {
    const app = await seedProduct({ slug: 'openbattery' })
    const release = await seedRelease({ productId: app.id, version: '1.0.0' })

    const response = await admin(`/products/${app.id}/releases/${release.id}`, { method: 'DELETE' })

    expect(response.status).toBe(204)
    expect((await admin(`/products/${app.id}/releases/${release.id}`)).status).toBe(404)
  })

  it('will not delete a release through the wrong product', async () => {
    const mine = await seedProduct({ slug: 'mine' })
    const theirs = await seedProduct({ slug: 'theirs' })
    const release = await seedRelease({ productId: theirs.id, version: '9.9.9' })

    expect((await admin(`/products/${mine.id}/releases/${release.id}`, { method: 'DELETE' })).status).toBe(404)
  })
})
