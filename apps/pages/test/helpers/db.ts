import { env } from 'cloudflare:test'
import { getDb } from '@/db/client'
import {
  applicationReleaseFiles,
  applications,
  applicationUpdates,
  applicationWikiPages,
  auditLogs,
  downloadEvents,
  paymentEvents,
  purchases,
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
 * Children first: `application_updates` and `application_wiki_pages` hold foreign keys onto
 * `applications`, and D1 enforces them, so deleting the parent table first fails the batch.
 */
const clearDatabase = async () => {
  await env.DB.batch([
    // Before `application_updates`, which it holds a foreign key onto.
    env.DB.prepare('DELETE FROM application_release_files'),
    env.DB.prepare('DELETE FROM application_updates'),
    env.DB.prepare('DELETE FROM application_wiki_pages'),
    env.DB.prepare('DELETE FROM applications'),
    env.DB.prepare('DELETE FROM audit_logs'),
    // No foreign keys on these three, deliberately: a payment and a download outlive the page they
    // were made for. They still have to be cleared between tests.
    env.DB.prepare('DELETE FROM purchases'),
    env.DB.prepare('DELETE FROM payment_events'),
    env.DB.prepare('DELETE FROM download_events'),
  ])
}

type ApplicationSeed = Partial<typeof applications.$inferInsert>

const seedApplication = async (seed: ApplicationSeed = {}) => {
  const now = new Date()
  const row = {
    id: crypto.randomUUID(),
    slug: seed.slug ?? `app-${crypto.randomUUID().slice(0, 8)}`,
    name: 'Seeded application',
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
    overviewBody: '# Seeded application',
    contactBody: null,
    translations: '{}',
    publishedAt: now,
    createdBy: 'seed@franciscosolis.cl',
    updatedBy: 'seed@franciscosolis.cl',
    createdAt: now,
    updatedAt: now,
    ...seed,
  }
  await db().insert(applications).values(row)
  return row
}

type UpdateSeed = Partial<typeof applicationUpdates.$inferInsert> & { applicationId: string }

const seedUpdate = async (seed: UpdateSeed) => {
  const now = new Date()
  const row = {
    id: crypto.randomUUID(),
    version: seed.version ?? `1.0.${Math.floor(Math.random() * 1000)}`,
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
  await db().insert(applicationUpdates).values(row)
  return row
}

type WikiSeed = Partial<typeof applicationWikiPages.$inferInsert> & { applicationId: string }

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
  await db().insert(applicationWikiPages).values(row)
  return row
}

type ReleaseFileSeed = Partial<typeof applicationReleaseFiles.$inferInsert> & {
  applicationId: string
  updateId: string
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
    objectKey: objectKeyFor(seed.applicationId, seed.updateId, id),
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
  await db().insert(applicationReleaseFiles).values(row)
  if (row.uploadedAt !== null) {
    await env.RELEASES.put(row.objectKey, contents)
  }
  return row
}

type PurchaseSeed = Partial<typeof purchases.$inferInsert> & { applicationId: string; applicationSlug: string }

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
    preferenceId: 'pref-1',
    paymentId: null,
    externalReference: crypto.randomUUID(),
    approvedAt: now,
    refundedAt: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...seed,
  }
  await db().insert(purchases).values(row)
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
  applicationReleaseFiles,
  applications,
  applicationUpdates,
  applicationWikiPages,
  auditLogs,
  clearDatabase,
  countRows,
  db,
  downloadEvents,
  paymentEvents,
  purchases,
  readAuditLog,
  seedApplication,
  seedPurchase,
  seedReleaseFile,
  seedUpdate,
  seedWikiPage,
}
