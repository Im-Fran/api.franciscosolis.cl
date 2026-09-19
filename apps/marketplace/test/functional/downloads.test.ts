import { SELF, env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COOLDOWN_SECONDS } from '@/lib/downloads'
import { clearDatabase, seedProduct, seedPurchase, seedReleaseFile, seedRelease } from '../helpers/db'
import { asBuyer } from '../helpers/tokens'

const call = (path: string, init: RequestInit = {}) => SELF.fetch(`https://marketplace.test${path}`, init)

/** A paid product with one published build behind it — the shape every test here starts from. */
const paidRelease = async (overrides: Record<string, unknown> = {}) => {
  const product = await seedProduct({
    slug: 'openbattery',
    name: 'OpenBattery',
    pricingMode: 'paid',
    priceAmount: 4990,
    ...overrides,
  })
  const release = await seedRelease({ productId: product.id, version: '2.6.4' })
  const file = await seedReleaseFile({ productId: product.id, releaseId: release.id, filename: 'app-2.6.4.jar' })
  return { product, release, file }
}

const ticketFor = async (slug: string, fileId: string, headers: Record<string, string> = {}) => {
  const response = await call(`/products/${slug}/files/${fileId}/download`, { method: 'POST', headers })
  return { response, body: (await response.json()) as { data?: { url: string; cooldown_seconds: number; paid: boolean } } }
}

/**
 * The path of a minted ticket as *this* Worker sees it.
 *
 * A minted URL is the public one — `MARKETPLACE_PUBLIC_URL` plus the path — and the public one carries the
 * `/pages` prefix the gateway strips before forwarding. Calling `SELF` with the prefix left on hits no
 * route at all, which is a plain 404 that looks exactly like a missing file.
 */
const pathOf = (url: string) => new URL(url).pathname.replace(/^\/marketplace/, '')

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /products/:slug/releases/:channel/:version/files', () => {
  beforeEach(clearDatabase)

  it('lists the builds of a published release and says whether paying comes first', async () => {
    await paidRelease()

    const response = await call('/products/openbattery/releases/release/2.6.4/files')
    const { data } = (await response.json()) as { data: { files: Record<string, unknown>[]; requires_payment: boolean } }

    expect(response.status).toBe(200)
    expect(data.requires_payment).toBe(true)
    expect(data.files).toHaveLength(1)
    expect(data.files[0]).toMatchObject({ filename: 'app-2.6.4.jar', platform: 'any' })
  })

  it('never exposes the object key or a bucket URL', async () => {
    await paidRelease()

    const text = await (await call('/products/openbattery/releases/release/2.6.4/files')).text()

    // The only way to the bytes is a minted ticket. A key in this body would be a second way.
    expect(text).not.toContain('releases/')
    expect(text).not.toContain('object_key')
  })

  it('leaves out a file whose bytes were never uploaded', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    const release = await seedRelease({ productId: product.id, version: '1.0' })
    await seedReleaseFile({ productId: product.id, releaseId: release.id, uploadedAt: null })

    const { data } = (await (await call('/products/openbattery/releases/release/1.0/files')).json()) as {
      data: { files: unknown[] }
    }
    expect(data.files).toEqual([])
  })

  it('does not exist for a draft release', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    const release = await seedRelease({ productId: product.id, version: '3.0', status: 'draft' })
    await seedReleaseFile({ productId: product.id, releaseId: release.id })

    expect((await call('/products/openbattery/releases/release/3.0/files')).status).toBe(404)
  })
})

describe('POST /products/:slug/files/:id/download', () => {
  beforeEach(clearDatabase)

  it('refuses a paid product with 402 until it has been paid for', async () => {
    const { file } = await paidRelease()

    const { response } = await ticketFor('openbattery', file.id)

    // The gate is here, not in the front-end: a page that forgot to show the modal still cannot
    // download the build.
    expect(response.status).toBe(402)
  })

  it('mints a ticket that works immediately for somebody who paid', async () => {
    const { product, file } = await paidRelease()
    await seedPurchase({ productId: product.id, productSlug: product.slug })

    const { response, body } = await ticketFor('openbattery', file.id, await asBuyer())

    expect(response.status).toBe(201)
    expect(body.data?.paid).toBe(true)
    expect(body.data?.cooldown_seconds).toBe(0)
    expect((await call(pathOf(body.data!.url))).status).toBe(200)
  })

  /**
   * A free product has no payer and no non-payer, so it has no cooldown either: the wait exists to
   * make the payment offer worth reading, and there is no offer. The ticket's own default would
   * have applied the five seconds anyway, which is why the route passes the number explicitly.
   */
  it('mints a ticket that works immediately for a free product', async () => {
    const product = await seedProduct({ slug: 'gratis' })
    const release = await seedRelease({ productId: product.id, version: '1.0' })
    const file = await seedReleaseFile({ productId: product.id, releaseId: release.id })

    const { body } = await ticketFor('gratis', file.id)

    expect(body.data?.cooldown_seconds).toBe(0)
    expect((await call(pathOf(body.data!.url))).status).toBe(200)
  })

  it('mints a ticket behind a five-second cooldown for a non-payer of an optional-pay product', async () => {
    const product = await seedProduct({ slug: 'freebie', pricingMode: 'donation', suggestedAmount: 2000 })
    const release = await seedRelease({ productId: product.id, version: '1.0' })
    const file = await seedReleaseFile({ productId: product.id, releaseId: release.id })

    const { response, body } = await ticketFor('freebie', file.id)

    expect(response.status).toBe(201)
    expect(body.data?.cooldown_seconds).toBe(COOLDOWN_SECONDS)

    // 425: the link is good, it is just not time yet — so a client may retry it unchanged.
    expect((await call(pathOf(body.data!.url))).status).toBe(425)

    vi.setSystemTime(Date.now() + (COOLDOWN_SECONDS + 1) * 1000)
    expect((await call(pathOf(body.data!.url))).status).toBe(200)
  })

  it('refuses a file reached through another product\'s path', async () => {
    const { file } = await paidRelease()
    await seedProduct({ slug: 'elsewhere' })

    const { response } = await ticketFor('elsewhere', file.id, await asBuyer())
    expect(response.status).toBe(404)
  })

  it('refuses a build hanging off a release that is still a draft', async () => {
    const product = await seedProduct({ slug: 'gratis' })
    const release = await seedRelease({ productId: product.id, version: '9.9', status: 'draft' })
    const file = await seedReleaseFile({ productId: product.id, releaseId: release.id })

    // Hiding a release has to hide what hangs off it, not just its text.
    expect((await ticketFor('gratis', file.id)).response.status).toBe(404)
  })
})

describe('GET /downloads/:ticket', () => {
  beforeEach(clearDatabase)

  it('serves the bytes, names the file and never lets a shared cache keep them', async () => {
    const product = await seedProduct({ slug: 'gratis' })
    const release = await seedRelease({ productId: product.id, version: '1.0' })
    const file = await seedReleaseFile(
      { productId: product.id, releaseId: release.id, filename: 'gratis-1.0.zip' },
      'the-actual-bytes',
    )

    const { body } = await ticketFor('gratis', file.id)
    vi.setSystemTime(Date.now() + (COOLDOWN_SECONDS + 1) * 1000)
    const response = await call(pathOf(body.data!.url))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('the-actual-bytes')
    expect(response.headers.get('Content-Disposition')).toContain('gratis-1.0.zip')
    expect(response.headers.get('Cache-Control')).toContain('private')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('records the download against the account that made it', async () => {
    const { product, file } = await paidRelease()
    await seedPurchase({ productId: product.id, productSlug: product.slug })

    const { body } = await ticketFor('openbattery', file.id, await asBuyer())
    await call(pathOf(body.data!.url))

    const row = await env.DB.prepare(
      'SELECT user_id, paid, version, filename, product_slug FROM download_events',
    ).first<{ user_id: string; paid: number; version: string; filename: string; product_slug: string }>()

    expect(row).toMatchObject({
      user_id: 'buyer-1',
      paid: 1,
      version: '2.6.4',
      filename: 'app-2.6.4.jar',
      product_slug: 'openbattery',
    })
  })

  it('counts the download on the file', async () => {
    const product = await seedProduct({ slug: 'gratis' })
    const release = await seedRelease({ productId: product.id, version: '1.0' })
    const file = await seedReleaseFile({ productId: product.id, releaseId: release.id })

    const { body } = await ticketFor('gratis', file.id)
    vi.setSystemTime(Date.now() + (COOLDOWN_SECONDS + 1) * 1000)
    await call(pathOf(body.data!.url))

    const row = await env.DB.prepare('SELECT download_count FROM product_release_files WHERE id = ?')
      .bind(file.id)
      .first<{ download_count: number }>()
    expect(row?.download_count).toBe(1)
  })

  it('refuses a forged ticket with 403 and a malformed one with 400', async () => {
    expect((await call('/downloads/bm90LWEtdGlja2V0.AAAA')).status).toBe(403)
    expect((await call('/downloads/nonsense')).status).toBe(400)
  })

  it('stops working once the file is unpublished, ticket in hand or not', async () => {
    const product = await seedProduct({ slug: 'gratis' })
    const release = await seedRelease({ productId: product.id, version: '1.0' })
    const file = await seedReleaseFile({ productId: product.id, releaseId: release.id })

    const { body } = await ticketFor('gratis', file.id)
    await env.DB.prepare('UPDATE product_release_files SET status = ? WHERE id = ?').bind('draft', file.id).run()

    vi.setSystemTime(Date.now() + (COOLDOWN_SECONDS + 1) * 1000)
    expect((await call(pathOf(body.data!.url))).status).toBe(404)
  })

  it('honours a range request so a download can be resumed', async () => {
    const product = await seedProduct({ slug: 'gratis' })
    const release = await seedRelease({ productId: product.id, version: '1.0' })
    const file = await seedReleaseFile({ productId: product.id, releaseId: release.id }, '0123456789')

    const { body } = await ticketFor('gratis', file.id)
    vi.setSystemTime(Date.now() + (COOLDOWN_SECONDS + 1) * 1000)
    const response = await call(pathOf(body.data!.url), { headers: { Range: 'bytes=2-5' } })

    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10')
    expect(await response.text()).toBe('2345')
  })
})
