import { env } from 'cloudflare:test'
import { getDb } from '@/db/client'
import {
  auditLogs,
  downloadEvents,
  paymentEvents,
  productDailyStats,
  productReleaseCompatibility,
  productReleaseFiles,
  productReleases,
  productReviewReports,
  productReviews,
  products,
  productWikiPages,
  purchases,
  saleVouchers,
} from '@/db/schema'
import { objectKeyFor } from '@/lib/files'

/**
 * Seeding helpers over the live D1 instance.
 *
 * `@cloudflare/vitest-pool-workers` gives every test *file* its own database but does not roll a
 * test back, so rows written by one test are still there in the next one. Every file therefore
 * clears the tables in a `beforeEach` rather than relying on isolation it does not get.
 */

const db = () => getDb(env)

/**
 * Children first, and D1 enforces the foreign keys, so the order is not cosmetic: deleting a parent
 * before its children fails the whole batch. Reports hang off reviews, reviews and compatibility
 * and files hang off releases, and everything content-shaped hangs off `products`.
 */
const clearDatabase = async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM product_review_reports'),
    env.DB.prepare('DELETE FROM product_reviews'),
    env.DB.prepare('DELETE FROM product_release_compatibility'),
    env.DB.prepare('DELETE FROM product_release_files'),
    env.DB.prepare('DELETE FROM product_releases'),
    env.DB.prepare('DELETE FROM product_wiki_pages'),
    env.DB.prepare('DELETE FROM products'),
    env.DB.prepare('DELETE FROM audit_logs'),
    // No foreign keys on the rest, deliberately: a payment, a download and a day's traffic all
    // outlive the page they were about. They still have to be cleared between tests.
    env.DB.prepare('DELETE FROM purchases'),
    env.DB.prepare('DELETE FROM payment_events'),
    env.DB.prepare('DELETE FROM download_events'),
    env.DB.prepare('DELETE FROM product_daily_stats'),
    env.DB.prepare('DELETE FROM sale_vouchers'),
    env.DB.prepare('DELETE FROM ai_requests'),
  ])
}

type ProductSeed = Partial<typeof products.$inferInsert>

const seedProduct = async (seed: ProductSeed = {}) => {
  const now = new Date()
  const row = {
    id: crypto.randomUUID(),
    slug: seed.slug ?? `app-${crypto.randomUUID().slice(0, 8)}`,
    name: 'Seeded product',
    tagline: null,
    summary: null,
    status: 'published',
    featured: false,
    position: 0,
    bannerImageUrl: null,
    iconImageUrl: null,
    accentColor: null,
    tabs: '["overview"]',
    links: '[]',
    overviewBody: '# Seeded product',
    contactBody: null,
    category: null,
    preReleaseRequiresPurchase: false,
    viewCount: 0,
    downloadCount: 0,
    translations: '{}',
    publishedAt: now,
    createdBy: 'seed@franciscosolis.cl',
    updatedBy: 'seed@franciscosolis.cl',
    createdAt: now,
    updatedAt: now,
    ...seed,
  }
  await db().insert(products).values(row)
  return row
}

type ReleaseSeed = Partial<typeof productReleases.$inferInsert> & { productId: string }

const seedRelease = async (seed: ReleaseSeed) => {
  const now = new Date()
  const row = {
    id: crypto.randomUUID(),
    version: seed.version ?? `1.0.${Math.floor(Math.random() * 1000)}`,
    channel: 'release',
    resetsRating: false,
    viewCount: 0,
    downloadCount: 0,
    title: 'Seeded release',
    body: 'Seeded changelog',
    status: 'published',
    releasedAt: now,
    links: '[]',
    translations: '{}',
    publishedAt: now,
    createdBy: 'seed@franciscosolis.cl',
    updatedBy: 'seed@franciscosolis.cl',
    createdAt: now,
    updatedAt: now,
    ...seed,
  }
  await db().insert(productReleases).values(row)
  return row
}

type WikiSeed = Partial<typeof productWikiPages.$inferInsert> & { productId: string }

const seedWikiPage = async (seed: WikiSeed) => {
  const now = new Date()
  const row = {
    id: crypto.randomUUID(),
    parentId: null,
    slug: seed.slug ?? `page-${crypto.randomUUID().slice(0, 8)}`,
    title: 'Seeded wiki page',
    icon: null,
    body: '# Seeded wiki page',
    status: 'published',
    position: 0,
    translations: '{}',
    publishedAt: now,
    createdBy: 'seed@franciscosolis.cl',
    updatedBy: 'seed@franciscosolis.cl',
    createdAt: now,
    updatedAt: now,
    ...seed,
  }
  await db().insert(productWikiPages).values(row)
  return row
}

type ReleaseFileSeed = Partial<typeof productReleaseFiles.$inferInsert> & {
  productId: string
  releaseId: string
}

/**
 * Seeds a release file *and its bytes*, because a row without an upload is invisible to every public
 * route — `uploadedAt` being null is exactly what "this file is not ready" means.
 */
const seedReleaseFile = async (seed: ReleaseFileSeed, contents = 'seeded-build-bytes') => {
  const now = new Date()
  const id = seed.id ?? crypto.randomUUID()
  const row = {
    id,
    objectKey: objectKeyFor(seed.productId, seed.releaseId, id),
    filename: seed.filename ?? 'seeded.zip',
    contentType: 'application/zip',
    size: contents.length,
    checksum: null,
    platform: 'any',
    label: null,
    position: 0,
    status: 'published',
    uploadedAt: now,
    downloadCount: 0,
    createdBy: 'seed@franciscosolis.cl',
    updatedBy: 'seed@franciscosolis.cl',
    createdAt: now,
    updatedAt: now,
    ...seed,
  }
  await db().insert(productReleaseFiles).values(row)
  if (row.uploadedAt !== null) {
    await env.RELEASES.put(row.objectKey, contents)
  }
  return row
}

type CompatibilitySeed = Partial<typeof productReleaseCompatibility.$inferInsert> & {
  productId: string
  releaseId: string
}

const seedCompatibility = async (seed: CompatibilitySeed) => {
  const now = new Date()
  const row = {
    id: crypto.randomUUID(),
    kind: 'os',
    name: 'macOS',
    constraintText: '>= 14.0',
    optional: false,
    position: 0,
    createdBy: 'seed@franciscosolis.cl',
    updatedBy: 'seed@franciscosolis.cl',
    createdAt: now,
    updatedAt: now,
    ...seed,
  }
  await db().insert(productReleaseCompatibility).values(row)
  return row
}

type ReviewSeed = Partial<typeof productReviews.$inferInsert> & { productId: string }

const seedReview = async (seed: ReviewSeed) => {
  const now = new Date()
  const row = {
    id: crypto.randomUUID(),
    releaseId: null,
    releaseVersion: null,
    releaseChannel: null,
    anchoredAt: now,
    userId: seed.userId ?? `reviewer-${crypto.randomUUID().slice(0, 8)}`,
    email: 'reviewer@example.com',
    authorName: 'A Reviewer',
    rating: 5,
    title: 'Seeded review',
    body: 'Seeded body',
    status: 'visible',
    reportCount: 0,
    replyBody: null,
    replyBy: null,
    replyAt: null,
    replyUpdatedAt: null,
    createdAt: now,
    updatedAt: now,
    ...seed,
  }
  await db().insert(productReviews).values(row)
  return row
}

type ReportSeed = Partial<typeof productReviewReports.$inferInsert> & { reviewId: string; productId: string }

const seedReport = async (seed: ReportSeed) => {
  const row = {
    id: crypto.randomUUID(),
    reporterUserId: `reporter-${crypto.randomUUID().slice(0, 8)}`,
    reporterEmail: 'reporter@example.com',
    reason: 'spam',
    note: null,
    status: 'open',
    createdAt: new Date(),
    ...seed,
  }
  await db().insert(productReviewReports).values(row)
  return row
}

type DownloadEventSeed = Partial<typeof downloadEvents.$inferInsert> & { productId: string }

/** A download on record, which is the second of the two ways a review becomes eligible. */
const seedDownloadEvent = async (seed: DownloadEventSeed) => {
  const row = {
    id: crypto.randomUUID(),
    fileId: crypto.randomUUID(),
    productSlug: 'seeded-app',
    releaseId: crypto.randomUUID(),
    version: '1.0.0',
    channel: 'release',
    filename: 'seeded.zip',
    userId: null,
    purchaseId: null,
    paid: false,
    ip: null,
    userAgent: null,
    createdAt: new Date(),
    ...seed,
  }
  await db().insert(downloadEvents).values(row)
  return row
}

type PurchaseSeed = Partial<typeof purchases.$inferInsert> & { productId: string; productSlug: string }

const seedPurchase = async (seed: PurchaseSeed) => {
  const now = new Date()
  const row = {
    id: crypto.randomUUID(),
    kind: 'purchase',
    userId: 'buyer-1',
    email: 'buyer@example.com',
    status: 'approved',
    amount: 4990,
    currency: 'CLP',
    provider: 'mercadopago',
    source: 'mercadopago',
    // Every seeded sale is a live one unless a test says otherwise: `sandbox` is what the suite's
    // own configuration is, so a refund test that forgot to seed this would pass for the wrong
    // reason — the environment guard would let it through by accident.
    environment: 'live',
    preferenceId: 'pref-1',
    paymentId: null,
    externalReference: crypto.randomUUID(),
    approvedAt: now,
    refundedAt: null,
    refundedAmount: null,
    refundReason: null,
    refundedBy: null,
    refundId: null,
    note: null,
    createdBy: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...seed,
  }
  await db().insert(purchases).values(row)
  return row
}

type VoucherSeed = Partial<typeof saleVouchers.$inferInsert> & { purchaseId: string; productId: string }

const seedVoucher = async (seed: VoucherSeed) => {
  const now = new Date()
  const row = {
    id: crypto.randomUUID(),
    number: seed.number ?? `FS-2026-${String(Math.floor(Math.random() * 999999)).padStart(6, '0')}`,
    productSlug: 'seeded-app',
    productName: 'Seeded product',
    email: 'buyer@example.com',
    kind: 'purchase',
    amount: 4990,
    currency: 'CLP',
    source: 'mercadopago',
    status: 'issued',
    locale: 'en',
    issuedBy: null,
    issuedAt: now,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    sentCount: 0,
    lastSentAt: null,
    lastSentTo: null,
    createdAt: now,
    updatedAt: now,
    ...seed,
  }
  await db().insert(saleVouchers).values(row)
  return row
}

const countRows = async (table: string): Promise<number> => {
  const row = await env.DB.prepare(`SELECT count(*) AS total FROM ${table}`).first<{ total: number }>()
  return row?.total ?? 0
}

/** Every audit row, newest first, with `metadata` already parsed. */
const readAuditLog = async () => {
  const { results } = await env.DB.prepare(
    'SELECT event, actor_email, actor_id, resource_type, resource_id, ip, user_agent, metadata FROM audit_logs ORDER BY rowid DESC',
  ).all<{
    event: string
    actor_email: string | null
    actor_id: string | null
    resource_type: string | null
    resource_id: string | null
    ip: string | null
    user_agent: string | null
    metadata: string | null
  }>()

  return results.map((row) => ({
    ...row,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
  }))
}

export {
  productReleaseFiles,
  products,
  productReleases,
  productWikiPages,
  auditLogs,
  clearDatabase,
  countRows,
  db,
  downloadEvents,
  paymentEvents,
  purchases,
  readAuditLog,
  saleVouchers,
  productReleaseCompatibility,
  productReviewReports,
  productReviews,
  seedCompatibility,
  seedDownloadEvent,
  seedReport,
  seedReview,
  seedProduct,
  seedPurchase,
  seedReleaseFile,
  seedRelease,
  seedVoucher,
  seedWikiPage,
}
