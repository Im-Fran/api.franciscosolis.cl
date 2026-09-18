import { env } from 'cloudflare:test'
import { getDb } from '@/db/client'
import { applications, applicationUpdates, applicationWikiPages, auditLogs } from '@/db/schema'

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
    env.DB.prepare('DELETE FROM application_updates'),
    env.DB.prepare('DELETE FROM application_wiki_pages'),
    env.DB.prepare('DELETE FROM applications'),
    env.DB.prepare('DELETE FROM audit_logs'),
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
  applications,
  applicationUpdates,
  applicationWikiPages,
  auditLogs,
  clearDatabase,
  countRows,
  db,
  readAuditLog,
  seedApplication,
  seedUpdate,
  seedWikiPage,
}
