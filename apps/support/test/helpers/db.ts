import { env } from 'cloudflare:test'

/**
 * `@cloudflare/vitest-pool-workers` gives every test *file* its own database but does not roll a
 * test back, so state written by one `it` is visible to the next. Every file therefore clears the
 * tables in a `beforeEach`.
 *
 * Children before parents, because D1 enforces the foreign keys. `support_counters` is reset rather
 * than emptied: the counter row is seeded by a migration and a test that deleted it would make every
 * later ticket creation throw.
 */
const clearDatabase = async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM ticket_notifications'),
    env.DB.prepare('DELETE FROM ticket_events'),
    env.DB.prepare('DELETE FROM ticket_labels'),
    env.DB.prepare('DELETE FROM ticket_messages'),
    env.DB.prepare('DELETE FROM ticket_participants'),
    env.DB.prepare('DELETE FROM email_messages'),
    env.DB.prepare('DELETE FROM inbound_emails'),
    env.DB.prepare('DELETE FROM tickets'),
    env.DB.prepare('DELETE FROM help_article_feedback'),
    env.DB.prepare('DELETE FROM help_search'),
    env.DB.prepare('DELETE FROM help_articles'),
    env.DB.prepare('DELETE FROM help_categories'),
    env.DB.prepare('DELETE FROM help_search_queries'),
    env.DB.prepare('DELETE FROM ai_requests'),
    env.DB.prepare('DELETE FROM audit_logs'),
    env.DB.prepare("UPDATE support_counters SET value = 1000 WHERE name = 'ticket'"),
  ])
}

const countRows = async (table: string): Promise<number> => {
  const row = await env.DB.prepare(`SELECT count(*) AS total FROM ${table}`).first<{ total: number }>()
  return row?.total ?? 0
}

const firstRow = async <T = Record<string, unknown>>(sql: string, ...bindings: unknown[]): Promise<T | null> =>
  (await env.DB.prepare(sql)
    .bind(...bindings)
    .first<T>()) ?? null

const allRows = async <T = Record<string, unknown>>(sql: string, ...bindings: unknown[]): Promise<T[]> => {
  const { results } = await env.DB.prepare(sql)
    .bind(...bindings)
    .all<T>()
  return results
}

export { allRows, clearDatabase, countRows, firstRow }
