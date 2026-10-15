import { and, desc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute } from 'hono-openapi'
import * as v from 'valibot'
import { getDb, type Database } from '@/db/client'
import { apps, installations, usageEvents } from '@/db/schema'
import type { AppEnv } from '@/env'
import { APP_STATES, CHANNELS, EVENT_TYPES, ROLLUP, SERIES, TELEMETRY } from '@/lib/config'
import { parseJsonObject } from '@/lib/json'
import { zonedDay } from '@/lib/time'
import { dateInput, dayInput, optionalText, paginationQuery } from '@/lib/validation'
import { readOptionalJson, validate } from '@/lib/validate'
import { diff, getActorContext, recordAudit } from '@/services/audit'
import { dailyStats, metricsSeries, rawWindowStart } from '@/services/series'
import { toInstallation } from '@/services/serialize'
import { assertId, dataSchema, jsonContent, notFound, page, panelErrors } from '@/panel/shared'

/**
 * One installation: its live view, what the panel may change about it, and its telemetry.
 */
const app = new Hono<AppEnv>()

const installationSchema = v.looseObject({ id: v.string(), app_id: v.string(), connected: v.boolean() })

const load = async (db: Database, id: string) => {
  const [row] = await db
    .select({ installation: installations, appState: apps.state, interval: apps.heartbeatIntervalSeconds })
    .from(installations)
    .innerJoin(apps, eq(apps.id, installations.appId))
    .where(eq(installations.id, id))
    .limit(1)
  if (!row) throw notFound('Installation')
  return { row: row.installation, app: { state: row.appState, heartbeatIntervalSeconds: row.interval } }
}

const view = async (db: Database, id: string) => {
  const { row, app: appInfo } = await load(db, id)
  return toInstallation(row, appInfo)
}

app.get(
  '/installations/:installationId',
  describeRoute({
    description: 'One installation: what it runs, whether it is connected, its last snapshot (absent measurements are what the platform cannot report) and the state it is obeying.',
    tags: ['Installations'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The installation', content: jsonContent(dataSchema(installationSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('installationId'), 'Installation')
    return c.json({ code: 200 as const, data: await view(getDb(c.env), id) })
  },
)

const patchSchema = v.object({
  alias: optionalText(120),
  channel: v.optional(v.picklist(CHANNELS)),
  state_override: v.optional(v.nullable(v.picklist(APP_STATES))),
  state_message: optionalText(1000),
})

app.patch(
  '/installations/:installationId',
  describeRoute({
    description:
      'Renames an installation, moves it to another channel, or overrides the app state for it alone — one kiosk into maintenance while the rest keep selling. `state_override: null` makes it follow the app again.',
    tags: ['Installations'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Updated', content: jsonContent(dataSchema(installationSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('json', patchSchema),
  async (c) => {
    const id = assertId(c.req.param('installationId'), 'Installation')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await view(db, id)
    await db
      .update(installations)
      .set({
        ...(body.alias !== undefined && { alias: body.alias }),
        ...(body.channel !== undefined && { channel: body.channel }),
        ...(body.state_override !== undefined && { stateOverride: body.state_override }),
        ...(body.state_message !== undefined && { stateMessage: body.state_message }),
        updatedAt: new Date(),
      })
      .where(eq(installations.id, id))
    const after = await view(db, id)
    const { before: changedBefore, after: changedAfter } = diff(before, after)
    // `connected` and `last_seen_at` move on their own between the two reads; they are not an edit.
    for (const key of ['connected', 'last_seen_at']) {
      delete changedBefore[key]
      delete changedAfter[key]
    }
    await recordAudit(db, {
      event: 'installation.updated',
      resourceType: 'installation',
      resourceId: id,
      ...actor,
      metadata: { app_id: after.app_id, before: changedBefore, after: changedAfter },
    })
    return c.json({ code: 200 as const, data: after })
  },
)

app.post(
  '/installations/:installationId/review',
  describeRoute({
    description: 'Marks a new installation as reviewed. Enrollment is auto-approved, so this is the step where a person confirms the device is one of the client\'s.',
    tags: ['Installations'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Reviewed', content: jsonContent(dataSchema(installationSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('installationId'), 'Installation')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const { row } = await load(db, id)
    if (row.needsReview) {
      await db
        .update(installations)
        .set({ needsReview: false, reviewedAt: new Date(), reviewedBy: actor.actorEmail, updatedAt: new Date() })
        .where(eq(installations.id, id))
      await recordAudit(db, { event: 'installation.reviewed', resourceType: 'installation', resourceId: id, ...actor, metadata: { app_id: row.appId } })
    }
    return c.json({ code: 200 as const, data: await view(db, id) })
  },
)

const revokeSchema = v.object({ reason: optionalText(500) })

app.post(
  '/installations/:installationId/revoke',
  describeRoute({
    description:
      'Revokes an installation: its tokens stop working on the very next request, and its device id can never enroll again. The rest of the fleet is untouched. Its history is kept.',
    tags: ['Installations'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Revoked', content: jsonContent(dataSchema(installationSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('installationId'), 'Installation')
    const body = await readOptionalJson(c, revokeSchema)
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const { row } = await load(db, id)
    if (row.status !== 'revoked') {
      const now = new Date()
      await db
        .update(installations)
        .set({
          status: 'revoked',
          revokedAt: now,
          revokedBy: actor.actorEmail,
          // The hashes are dropped, not just disowned: a revoked token must not even resolve to a row.
          accessTokenHash: null,
          accessTokenExpiresAt: null,
          refreshTokenHash: null,
          refreshTokenExpiresAt: null,
          needsReview: false,
          updatedAt: now,
        })
        .where(eq(installations.id, id))
      await recordAudit(db, {
        event: 'installation.revoked',
        resourceType: 'installation',
        resourceId: id,
        ...actor,
        metadata: { app_id: row.appId, device_id: row.deviceId, reason: body.reason ?? null },
      })
    }
    return c.json({ code: 200 as const, data: await view(db, id) })
  },
)

/* ── Telemetry ─────────────────────────────────────────────────────────────── */

app.get(
  '/installations/:installationId/metrics',
  describeRoute({
    description: `The installation's metrics between \`from\` and \`to\` (default: the last 24 hours), averaged into at most \`points\` buckets (default ${SERIES.defaultPoints}, at most ${SERIES.maxPoints}). Raw data is kept ${TELEMETRY.rawRetentionDays} days, so \`from\` is clamped to that; older days are in \`/metrics/daily\`.`,
    tags: ['Telemetry'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The series' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate(
    'query',
    v.object({
      from: v.optional(dateInput),
      to: v.optional(dateInput),
      points: v.optional(v.pipe(v.string(), v.regex(/^\d{1,4}$/), v.transform(Number), v.minValue(1), v.maxValue(SERIES.maxPoints))),
    }),
  ),
  async (c) => {
    const id = assertId(c.req.param('installationId'), 'Installation')
    const query = c.req.valid('query')
    await load(getDb(c.env), id)
    const now = new Date()
    const to = query.to && query.to < now ? query.to : now
    const requestedFrom = query.from ?? new Date(to.getTime() - SERIES.defaultRangeSeconds * 1000)
    const from = requestedFrom < rawWindowStart(now) ? rawWindowStart(now) : requestedFrom
    if (from >= to) {
      throw new HTTPException(400, { message: '`from` must be before `to`' })
    }
    return c.json({ code: 200 as const, data: await metricsSeries(c.env.DB, id, from, to, query.points ?? SERIES.defaultPoints) })
  },
)

app.get(
  '/installations/:installationId/metrics/daily',
  describeRoute({
    description:
      'One row per Santiago day: averages, maxima and 95th percentiles of CPU and memory, GPU, network totals, lowest battery, seconds connected and in use. Kept without expiry; today (and yesterday until the nightly roll-up) are computed live. Defaults to the last 30 days.',
    tags: ['Telemetry'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The days' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('query', v.object({ from: v.optional(dayInput), to: v.optional(dayInput) })),
  async (c) => {
    const id = assertId(c.req.param('installationId'), 'Installation')
    const query = c.req.valid('query')
    await load(getDb(c.env), id)
    const to = query.to ?? zonedDay(new Date(), ROLLUP.timeZone)
    const from = query.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - (TELEMETRY.rawRetentionDays - 1) * 86_400_000).toISOString().slice(0, 10)
    if (from > to) {
      throw new HTTPException(400, { message: '`from` must not be after `to`' })
    }
    return c.json({ code: 200 as const, data: await dailyStats(c.env.DB, id, from, to) })
  },
)

app.get(
  '/installations/:installationId/events',
  describeRoute({
    description: `The installation's usage events, newest first. Kept ${TELEMETRY.rawRetentionDays} days.`,
    tags: ['Telemetry'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The events' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('query', v.object({ type: v.optional(v.picklist(EVENT_TYPES)), ...paginationQuery })),
  async (c) => {
    const id = assertId(c.req.param('installationId'), 'Installation')
    const query = c.req.valid('query')
    const { limit, offset } = page(query)
    const db = getDb(c.env)
    await load(db, id)
    const where = and(eq(usageEvents.installationId, id), query.type ? eq(usageEvents.type, query.type) : undefined)
    const [rows, [total]] = await Promise.all([
      db.select().from(usageEvents).where(where).orderBy(desc(usageEvents.occurredAt), desc(usageEvents.eventId)).limit(limit).offset(offset),
      db.select({ count: sql<number>`COUNT(*)` }).from(usageEvents).where(where),
    ])
    return c.json({
      code: 200 as const,
      data: rows.map((row) => ({
        id: row.eventId,
        type: row.type,
        name: row.name,
        session_id: row.sessionId,
        occurred_at: new Date(row.occurredAt).toISOString(),
        received_at: row.receivedAt.toISOString(),
        properties: parseJsonObject(row.properties),
      })),
      pagination: { limit, offset, total: Number(total?.count ?? 0) },
    })
  },
)

export default app
