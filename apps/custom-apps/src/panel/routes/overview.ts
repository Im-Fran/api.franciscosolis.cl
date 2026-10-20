import { and, asc, desc, eq, gte, isNull, like, lte, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { apps, auditLogs, contracts, installations } from '@/db/schema'
import type { AppEnv } from '@/env'
import { APP_STATES, type AppState } from '@/lib/config'
import { parseJsonObject } from '@/lib/json'
import { dateInput, paginationQuery, searchQuery } from '@/lib/validation'
import { validate } from '@/lib/validate'
import { unresolvedCount } from '@/services/alerts'
import { todayIn, toContract } from '@/services/contracts'
import { toInstallationSummary } from '@/services/serialize'
import { connectedSql, nowSeconds, page, panelErrors } from '@/panel/shared'

/**
 * The panel's front page and its audit trail: the two views that are about everything at once.
 */
const app = new Hono<AppEnv>()

const RECENT = 10

app.get(
  '/overview',
  describeRoute({
    description:
      'What the home screen opens with: installations connected against the total, how many wait for review, apps by state, unresolved alerts, releases rolling out or paused, contracts ending or in grace, hours cycles over budget or waiting to be billed, support tickets waiting on us or on the client (`tickets.open` / `tickets.pending`) and how many tickets hold a requester message nobody opened yet (`tickets.unread`: tickets, not messages, and never a `closed` one, which takes no more messages), and the latest enrollments.',
    tags: ['Overview'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The overview' }, ...panelErrors },
  }),
  async (c) => {
    const db = getDb(c.env)
    const now = nowSeconds()
    const nowDate = new Date(now * 1000)

    const summaryColumns = { installation: installations, appName: apps.name, interval: apps.heartbeatIntervalSeconds }
    const [[fleet], states, [counts], recent, review, openAlerts, [rollouts], contractRows, [cycleRow], [ticketRow]] = await Promise.all([
      c.env.DB.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN i.status = 'active' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN ${connectedSql(now)} THEN 1 ELSE 0 END) AS connected,
                SUM(CASE WHEN i.status = 'active' AND i.needs_review = 1 THEN 1 ELSE 0 END) AS needs_review,
                SUM(CASE WHEN i.status = 'revoked' THEN 1 ELSE 0 END) AS revoked
         FROM installations i JOIN apps a ON a.id = i.app_id`,
      ).all<Record<string, number | null>>().then((result) => result.results),
      db.select({ state: apps.state, count: sql<number>`COUNT(*)` }).from(apps).groupBy(apps.state),
      c.env.DB.prepare('SELECT (SELECT COUNT(*) FROM companies) AS companies, (SELECT COUNT(*) FROM contacts) AS contacts')
        .all<{ companies: number; contacts: number }>()
        .then((result) => result.results),
      db.select(summaryColumns).from(installations).innerJoin(apps, eq(apps.id, installations.appId)).orderBy(desc(installations.enrolledAt), desc(installations.id)).limit(RECENT),
      db
        .select(summaryColumns)
        .from(installations)
        .innerJoin(apps, eq(apps.id, installations.appId))
        .where(and(eq(installations.needsReview, true), eq(installations.status, 'active')))
        .orderBy(asc(installations.enrolledAt), asc(installations.id))
        .limit(RECENT),
      unresolvedCount(db),
      c.env.DB.prepare(
        `SELECT SUM(CASE WHEN status = 'published' AND rollout_percent < 100 THEN 1 ELSE 0 END) AS rolling_out,
                SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) AS paused,
                SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS drafts
         FROM releases`,
      ).all<Record<string, number | null>>().then((result) => result.results),
      db.select().from(contracts).where(isNull(contracts.cancelledAt)),
      c.env.DB.prepare(
        `SELECT SUM(CASE WHEN y.status = 'open' AND (SELECT COALESCE(SUM(w.minutes), 0) FROM work_logs w WHERE w.cycle_id = y.id) > y.included_minutes + y.carried_minutes THEN 1 ELSE 0 END) AS exceeded,
                SUM(CASE WHEN y.status = 'closed' AND COALESCE(y.overage_minutes, 0) > 0 THEN 1 ELSE 0 END) AS to_bill
         FROM contract_cycles y JOIN contracts c ON c.id = y.contract_id`,
      ).all<Record<string, number | null>>().then((result) => result.results),
      c.env.DB.prepare(
        `SELECT SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status != 'closed' AND EXISTS (SELECT 1 FROM ticket_messages m WHERE m.ticket_id = tickets.id AND m.author = 'requester' AND m.seen_at IS NULL) THEN 1 ELSE 0 END) AS unread
         FROM tickets`,
      ).all<Record<string, number | null>>().then((result) => result.results),
    ])
    const today = todayIn(nowDate)
    const contractViews = contractRows.map((row) => toContract(row, { day: today }))

    const byState = Object.fromEntries(APP_STATES.map((state) => [state, 0])) as Record<AppState, number>
    for (const row of states) {
      if ((APP_STATES as readonly string[]).includes(row.state)) byState[row.state as AppState] = Number(row.count)
    }
    const summary = (row: (typeof recent)[number]) => ({
      ...toInstallationSummary(row.installation, row.interval, nowDate),
      app: { id: row.installation.appId, name: row.appName },
    })

    return c.json({
      code: 200 as const,
      data: {
        installations: {
          total: Number(fleet?.total ?? 0),
          active: Number(fleet?.active ?? 0),
          connected: Number(fleet?.connected ?? 0),
          needs_review: Number(fleet?.needs_review ?? 0),
          revoked: Number(fleet?.revoked ?? 0),
        },
        apps: { total: Object.values(byState).reduce((sum, count) => sum + count, 0), by_state: byState },
        companies: { total: Number(counts?.companies ?? 0) },
        contacts: { total: Number(counts?.contacts ?? 0) },
        alerts: { unresolved: openAlerts },
        contracts: {
          active: contractViews.filter((view) => view.status === 'active').length,
          expiring: contractViews.filter((view) => view.expiring).length,
          in_grace: contractViews.filter((view) => view.status === 'grace').length,
        },
        cycles: { exceeded: Number(cycleRow?.exceeded ?? 0), to_bill: Number(cycleRow?.to_bill ?? 0) },
        tickets: { open: Number(ticketRow?.open ?? 0), pending: Number(ticketRow?.pending ?? 0), unread: Number(ticketRow?.unread ?? 0) },
        releases: { rolling_out: Number(rollouts?.rolling_out ?? 0), paused: Number(rollouts?.paused ?? 0), drafts: Number(rollouts?.drafts ?? 0) },
        recent_installations: recent.map(summary),
        needs_review: review.map(summary),
      },
    })
  },
)

app.get(
  '/audit-log',
  describeRoute({
    description:
      'The audit trail, newest first. Append-only: the database refuses any change to it. Edits carry `{ before, after }` with only the fields that changed; things a device or the system did have no actor.',
    tags: ['Audit'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The entries' }, ...panelErrors },
  }),
  validate(
    'query',
    v.object({
      event: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(64))),
      resource_type: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(64))),
      resource_id: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(64))),
      actor: searchQuery,
      from: v.optional(dateInput),
      to: v.optional(dateInput),
      ...paginationQuery,
    }),
  ),
  async (c) => {
    const query = c.req.valid('query')
    const { limit, offset } = page(query)
    const db = getDb(c.env)
    const conditions = [
      // `app.` matches every app event; a full name matches exactly one.
      query.event ? (query.event.endsWith('.') ? like(auditLogs.event, `${query.event}%`) : eq(auditLogs.event, query.event)) : undefined,
      query.resource_type ? eq(auditLogs.resourceType, query.resource_type) : undefined,
      query.resource_id ? eq(auditLogs.resourceId, query.resource_id) : undefined,
      query.actor ? like(auditLogs.actorEmail, `%${query.actor.toLowerCase()}%`) : undefined,
      query.from ? gte(auditLogs.createdAt, query.from) : undefined,
      query.to ? lte(auditLogs.createdAt, query.to) : undefined,
    ].filter((condition) => condition !== undefined)
    const where = conditions.length ? and(...conditions) : undefined
    const [rows, [total]] = await Promise.all([
      db.select().from(auditLogs).where(where).orderBy(desc(auditLogs.createdAt), sql`${auditLogs}.rowid DESC`).limit(limit).offset(offset),
      db.select({ count: sql<number>`COUNT(*)` }).from(auditLogs).where(where),
    ])
    return c.json({
      code: 200 as const,
      data: rows.map((row) => ({
        id: row.id,
        event: row.event,
        actor_email: row.actorEmail,
        actor_id: row.actorId,
        resource_type: row.resourceType,
        resource_id: row.resourceId,
        ip: row.ip,
        user_agent: row.userAgent,
        metadata: parseJsonObject(row.metadata),
        created_at: row.createdAt.toISOString(),
      })),
      pagination: { limit, offset, total: Number(total?.count ?? 0) },
    })
  },
)

export default app
