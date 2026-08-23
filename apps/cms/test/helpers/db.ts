import { env } from 'cloudflare:test'
import { getDb } from '@/db/client'
import { auditLogs, contentEntries, emailMessages, emailTemplates, legalPages } from '@/db/schema'

/**
 * Seeding helpers over the live D1 instance.
 *
 * `@cloudflare/vitest-pool-workers` gives every test *file* its own database but does not roll a
 * test back, so rows written by one test are still there in the next one. Every file therefore
 * clears the tables in a `beforeEach` rather than relying on isolation it does not get.
 */

const db = () => getDb(env)

const clearDatabase = async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM content_entries'),
    env.DB.prepare('DELETE FROM legal_pages'),
    env.DB.prepare('DELETE FROM email_templates'),
    env.DB.prepare('DELETE FROM email_messages'),
    env.DB.prepare('DELETE FROM audit_logs'),
  ])
}

type EntrySeed = Partial<typeof contentEntries.$inferInsert>

const seedEntry = async (seed: EntrySeed = {}) => {
  const now = new Date()
  const slug = seed.slug ?? `entry-${crypto.randomUUID().slice(0, 8)}`
  const row = {
    id: crypto.randomUUID(),
    collection: 'projects',
    slug,
    title: 'Seeded entry',
    subtitle: null,
    summary: null,
    body: null,
    status: 'published',
    featured: false,
    position: 0,
    startedAt: null,
    endedAt: null,
    url: null,
    imageUrl: null,
    tags: '[]',
    data: '{}',
    translations: '{}',
    publishedAt: now,
    createdBy: 'seed@franciscosolis.cl',
    updatedBy: 'seed@franciscosolis.cl',
    createdAt: now,
    updatedAt: now,
    ...seed,
  }
  await db().insert(contentEntries).values(row)
  return row
}

type LegalSeed = Partial<typeof legalPages.$inferInsert>

const seedLegalPage = async (seed: LegalSeed = {}) => {
  const now = new Date()
  const row = {
    id: crypto.randomUUID(),
    slug: seed.slug ?? `page-${crypto.randomUUID().slice(0, 8)}`,
    title: 'Seeded page',
    summary: null,
    body: '# Seeded page',
    status: 'published',
    version: null,
    effectiveAt: null,
    translations: '{}',
    publishedAt: now,
    createdBy: 'seed@franciscosolis.cl',
    updatedBy: 'seed@franciscosolis.cl',
    createdAt: now,
    updatedAt: now,
    ...seed,
  }
  await db().insert(legalPages).values(row)
  return row
}

type TemplateSeed = Partial<typeof emailTemplates.$inferInsert>

const seedTemplate = async (seed: TemplateSeed = {}) => {
  const now = new Date()
  const row = {
    id: crypto.randomUUID(),
    slug: seed.slug ?? `template-${crypto.randomUUID().slice(0, 8)}`,
    name: 'Seeded template',
    description: null,
    subject: 'Hello',
    html: null,
    text: 'Hello',
    variables: '[]',
    createdBy: 'seed@franciscosolis.cl',
    updatedBy: 'seed@franciscosolis.cl',
    createdAt: now,
    updatedAt: now,
    ...seed,
  }
  await db().insert(emailTemplates).values(row)
  return row
}

type MessageSeed = Partial<typeof emailMessages.$inferInsert>

/**
 * Seeds a row of the outgoing-mail log.
 *
 * `createdAt` is settable because that is the only way to pin the "newest first" ordering of
 * `GET /admin/emails`: the column is unix seconds, so rows written by one test all land in the
 * same second and cannot be told apart by the sort.
 */
const seedMessage = async (seed: MessageSeed = {}) => {
  const row = {
    id: crypto.randomUUID(),
    toAddresses: '["someone@example.com"]',
    fromEmail: 'hola@mail.franciscosolis.cl',
    fromName: 'Francisco Solis',
    replyTo: null,
    subject: 'Seeded message',
    html: null,
    text: 'Seeded body',
    templateSlug: null,
    status: 'sent',
    messageId: '<seeded@mail.franciscosolis.cl>',
    error: null,
    sentBy: 'seed@franciscosolis.cl',
    sentAt: new Date(),
    createdAt: new Date(),
    ...seed,
  }
  await db().insert(emailMessages).values(row)
  return row
}

type AuditSeed = Partial<typeof auditLogs.$inferInsert>

/** Seeds an audit row. `createdAt` is settable for the same reason as `seedMessage`'s. */
const seedAuditRow = async (seed: AuditSeed = {}) => {
  const row = {
    id: crypto.randomUUID(),
    event: 'content.created',
    actorEmail: 'seed@franciscosolis.cl',
    actorId: 'editor-seed',
    resourceType: 'content_entries',
    resourceId: crypto.randomUUID(),
    ip: null,
    userAgent: null,
    metadata: null,
    createdAt: new Date(),
    ...seed,
  }
  await db().insert(auditLogs).values(row)
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
  auditLogs,
  clearDatabase,
  contentEntries,
  countRows,
  db,
  emailMessages,
  emailTemplates,
  legalPages,
  readAuditLog,
  seedAuditRow,
  seedEntry,
  seedLegalPage,
  seedMessage,
  seedTemplate,
}
