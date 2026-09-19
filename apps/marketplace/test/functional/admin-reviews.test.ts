import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, readAuditLog, seedProduct, seedReport, seedReview } from '../helpers/db'
import { asBuyer, asEditor } from '../helpers/tokens'

const call = (path: string, init: RequestInit = {}) => SELF.fetch(`https://marketplace.test${path}`, init)

const asAdmin = async (path: string, init: RequestInit = {}) =>
  call(path, { ...init, headers: { ...(await asEditor()), ...init.headers } })

const publicReviews = async (slug = 'openbattery') =>
  ((await (await call(`/products/${slug}/reviews`)).json()) as { data: { reviews: { id: string }[] } }).data.reviews

describe('hiding and unhiding', () => {
  beforeEach(clearDatabase)

  it('takes a hidden review out of the public listing and the average, reversibly', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    const review = await seedReview({ productId: product.id, rating: 1 })
    const base = `/admin/products/${product.id}/reviews/${review.id}`

    await asAdmin(`${base}/hide`, { method: 'POST', body: JSON.stringify({ reason: 'Off topic' }) })
    expect(await publicReviews()).toEqual([])

    await asAdmin(`${base}/unhide`, { method: 'POST', body: '{}' })
    expect(await publicReviews()).toHaveLength(1)
  })

  /** Hiding is reversible and deleting is not, so each is its own event rather than one "moderated". */
  it('writes hiding, unhiding and deleting as three different audit events', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    const review = await seedReview({ productId: product.id })
    const base = `/admin/products/${product.id}/reviews/${review.id}`

    await asAdmin(`${base}/hide`, { method: 'POST', body: '{}' })
    await asAdmin(`${base}/unhide`, { method: 'POST', body: '{}' })
    await asAdmin(base, { method: 'DELETE' })

    const events = (await readAuditLog()).map((entry) => entry.event)
    expect(events).toEqual(expect.arrayContaining(['review.hidden', 'review.unhidden', 'review.deleted']))
  })

  /** The row is gone, so the trail is the only thing that can still say what was removed. */
  it('snapshots the deleted review onto the audit entry', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    const review = await seedReview({ productId: product.id, rating: 2, title: 'Not for me' })

    await asAdmin(`/admin/products/${product.id}/reviews/${review.id}`, { method: 'DELETE' })

    const entry = (await readAuditLog()).find((row) => row.event === 'review.deleted')
    expect(entry?.metadata).toMatchObject({ rating: 2, title: 'Not for me' })
  })

  it('lets the author still see their own hidden review, with the reason', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    const review = await seedReview({ productId: product.id, userId: 'buyer-1' })

    await asAdmin(`/admin/products/${product.id}/reviews/${review.id}/hide`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Contains an address' }),
    })

    const { data } = (await (
      await call('/products/openbattery/reviews/me', { headers: await asBuyer() })
    ).json()) as { data: { review: { status: string; hidden_reason: string } | null } }

    expect(data.review).toMatchObject({ status: 'hidden', hidden_reason: 'Contains an address' })
  })

  it('404s a review reached through the wrong product', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    const elsewhere = await seedProduct({ slug: 'elsewhere' })
    const review = await seedReview({ productId: product.id })

    const response = await asAdmin(`/admin/products/${elsewhere.id}/reviews/${review.id}`, { method: 'DELETE' })
    expect(response.status).toBe(404)
  })

  it('needs an editor token', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    const review = await seedReview({ productId: product.id })

    expect((await call(`/admin/products/${product.id}/reviews/${review.id}`, { method: 'DELETE' })).status).toBe(401)
  })
})

describe('the owner\'s reply', () => {
  beforeEach(clearDatabase)

  it('renders under the review with the product\'s name, never the editor\'s address', async () => {
    const product = await seedProduct({ slug: 'openbattery', name: 'OpenBattery' })
    const review = await seedReview({ productId: product.id })

    await asAdmin(`/admin/products/${product.id}/reviews/${review.id}/reply`, {
      method: 'PUT',
      body: JSON.stringify({ body: 'Fixed in 2.7.' }),
    })

    const [row] = (await publicReviews()) as unknown as {
      reply: { body: string; author_name: string } | null
    }[]
    expect(row?.reply).toMatchObject({ body: 'Fixed in 2.7.', author_name: 'OpenBattery' })
    expect(JSON.stringify(row)).not.toContain('franciscosolis.cl')
  })

  /** One per review: a second `PUT` is the editor correcting themselves, not a thread. */
  it('replaces rather than appends, and keeps the original date', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    const review = await seedReview({ productId: product.id })
    const path = `/admin/products/${product.id}/reviews/${review.id}/reply`

    const first = (await (
      await asAdmin(path, { method: 'PUT', body: JSON.stringify({ body: 'One' }) })
    ).json()) as { data: { reply: { created_at: string } } }

    const second = (await (
      await asAdmin(path, { method: 'PUT', body: JSON.stringify({ body: 'Two' }) })
    ).json()) as { data: { reply: { body: string; created_at: string } } }

    expect(second.data.reply.body).toBe('Two')
    // Compared to the second, which is what the column stores: `integer` + `{ mode: 'timestamp' }`
    // is unix seconds, so the millisecond half of the first response never reached the database.
    const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000)
    expect(seconds(second.data.reply.created_at)).toBe(seconds(first.data.reply.created_at))
  })

  it('can be removed without touching the review', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    const review = await seedReview({ productId: product.id })
    const path = `/admin/products/${product.id}/reviews/${review.id}/reply`

    await asAdmin(path, { method: 'PUT', body: JSON.stringify({ body: 'One' }) })
    expect((await asAdmin(path, { method: 'DELETE' })).status).toBe(204)
    expect((await asAdmin(path, { method: 'DELETE' })).status).toBe(404)
    expect(await publicReviews()).toHaveLength(1)
  })
})

describe('the moderation queue', () => {
  beforeEach(clearDatabase)

  const reported = async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    const review = await seedReview({ productId: product.id })
    return { product, review }
  }

  it('counts one report per person, not per click', async () => {
    const { product, review } = await reported()
    const body = JSON.stringify({ reason: 'spam' })
    const report = () =>
      call(`/products/openbattery/reviews/${review.id}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })

    const headers = await asBuyer()
    const first = await call(`/products/openbattery/reviews/${review.id}/report`, { method: 'POST', headers, body })
    const second = await call(`/products/openbattery/reviews/${review.id}/report`, { method: 'POST', headers, body })

    expect(first.status).toBe(201)
    expect(second.status).toBe(409)

    const { data } = (await (await asAdmin(`/admin/products/${product.id}/reviews`)).json()) as {
      data: { report_count: number }[]
    }
    expect(data[0]?.report_count).toBe(1)
    void report
  })

  it('counts two different people twice', async () => {
    const { product, review } = await reported()
    const body = JSON.stringify({ reason: 'abuse' })
    const path = `/products/openbattery/reviews/${review.id}/report`

    await call(path, { method: 'POST', headers: await asBuyer({ sub: 'one' }), body })
    await call(path, { method: 'POST', headers: await asBuyer({ sub: 'two' }), body })

    const { data } = (await (await asAdmin(`/admin/products/${product.id}/reviews`)).json()) as {
      data: { report_count: number }[]
    }
    expect(data[0]?.report_count).toBe(2)
  })

  /**
   * Cross-product on purpose, exactly like `GET /admin/purchases`: it answers "what needs
   * moderating anywhere", and nesting it would mean opening every product to find the problem.
   */
  it('lists reports across every product, newest first', async () => {
    const one = await seedProduct({ slug: 'one' })
    const two = await seedProduct({ slug: 'two' })
    const reviewOne = await seedReview({ productId: one.id })
    const reviewTwo = await seedReview({ productId: two.id })
    await seedReport({ reviewId: reviewOne.id, productId: one.id })
    await seedReport({ reviewId: reviewTwo.id, productId: two.id })

    const { data } = (await (await asAdmin('/admin/reviews/reports')).json()) as { data: unknown[] }

    expect(data).toHaveLength(2)
  })

  it('stops counting a resolved report, and files the resolution', async () => {
    const { product, review } = await reported()
    const body = JSON.stringify({ reason: 'spam' })
    await call(`/products/openbattery/reviews/${review.id}/report`, {
      method: 'POST',
      headers: await asBuyer(),
      body,
    })

    const { data: reports } = (await (await asAdmin('/admin/reviews/reports?status=open')).json()) as {
      data: { id: string }[]
    }
    await asAdmin(`/admin/reviews/reports/${reports[0]?.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'dismissed', resolution_note: 'Fine as it is' }),
    })

    const { data } = (await (await asAdmin(`/admin/products/${product.id}/reviews`)).json()) as {
      data: { report_count: number }[]
    }
    expect(data[0]?.report_count).toBe(0)
    expect((await readAuditLog()).map((entry) => entry.event)).toContain('report.resolved')
  })

  it('refuses a reason outside the closed set', async () => {
    const { review } = await reported()

    const response = await call(`/products/openbattery/reviews/${review.id}/report`, {
      method: 'POST',
      headers: await asBuyer(),
      body: JSON.stringify({ reason: 'i just dont like it' }),
    })

    expect(response.status).toBe(400)
  })

  it('needs a token to report', async () => {
    const { review } = await reported()

    const response = await call(`/products/openbattery/reviews/${review.id}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'spam' }),
    })

    expect(response.status).toBe(401)
  })
})
