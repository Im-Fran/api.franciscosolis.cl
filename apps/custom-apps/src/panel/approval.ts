import { and, eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { describeRoute } from 'hono-openapi'
import * as v from 'valibot'
import { getDb, type Database } from '@/db/client'
import { apps, auditLogs, companies, maintenanceLinks, maintenances } from '@/db/schema'
import type { AppEnv } from '@/env'
import { MAINTENANCES } from '@/lib/config'
import { iso } from '@/lib/json'
import { hashToken, TOKEN_PREFIXES } from '@/lib/tokens'
import { optionalText, requiredText } from '@/lib/validation'
import { validate } from '@/lib/validate'
import { auditRow, getRequestContext } from '@/services/audit'
import { invalidateLinks, loadMaintenance, markScheduled, notifyOwner, windowLabel, windowsOf, type LinkRow, type MaintenanceRow, type WindowRow } from '@/services/maintenances'
import { dataSchema, jsonContent } from '@/panel/shared'

/**
 * The public half of maintenance approval: what the page at `franciscosolis.cl/mantencion/<token>`
 * reads and answers through. No login — the link is the credential, so it is treated like one.
 *
 * Mounted ahead of the `/v1` gate in `src/index.ts`, like the CI upload: `requireAdmin` never sees
 * these routes, and they accept nothing but a maintenance link. Only the token's SHA-256 is stored;
 * each recipient of each send has a link of their own, so an answer says who gave it. A link answers
 * once, while its maintenance waits on the client and before the first window it offered starts; a
 * later send replaces it. It keeps *reading* afterwards, so the page can show what became of the
 * request. Every route is limited per client IP (`PUBLIC_LIMITER`).
 *
 * What the page sees is what the client was told — the title, the description, the duration, the
 * app's and company's names and the windows. Never an installation, an internal id beyond the windows'
 * (which the answer has to name), or anybody's address.
 */
const app = new Hono<AppEnv>()

/** `mnt_` and 43 base64url characters: 32 random bytes. Anything else is a 404 without a lookup. */
const TOKEN_PATTERN = new RegExp(`^${TOKEN_PREFIXES.maintenance}[A-Za-z0-9_-]{43}$`)

const limited = createMiddleware<AppEnv>(async (c, next) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  const { success } = await c.env.PUBLIC_LIMITER.limit({ key: `maintenance-link:${ip}` })
  if (!success) {
    throw new HTTPException(429, { res: Response.json({ code: 429, error: 'Too many requests; try again in a minute' }, { status: 429, headers: { 'Retry-After': '60' } }) })
  }
  await next()
})

app.use('/public/*', limited)

/**
 * Where a link stands:
 *
 * - `open`: it can answer.
 * - `answered`: somebody answered through it.
 * - `closed`: the maintenance no longer waits on the client — answered through another link, applied
 *   without an answer, cancelled, or past.
 * - `superseded`: a later send replaced it.
 * - `expired`: the first window it offered started.
 */
type LinkState = 'open' | 'answered' | 'closed' | 'superseded' | 'expired'

const stateOf = (link: LinkRow, row: MaintenanceRow, now: Date): LinkState => {
  if (link.answer) return 'answered'
  if (row.status !== 'pending_approval') return 'closed'
  if (link.invalidatedAt) return 'superseded'
  if (now >= link.expiresAt) return 'expired'
  return 'open'
}

const GONE_MESSAGES: Record<Exclude<LinkState, 'open'>, string> = {
  answered: 'This request was already answered through this link',
  closed: 'This maintenance no longer waits for an answer',
  superseded: 'A newer request was sent; use the link in the latest email',
  expired: 'This link expired when the first window it offered started',
}

const resolve = async (c: Context<AppEnv>) => {
  const token = c.req.param('token') ?? ''
  if (!TOKEN_PATTERN.test(token)) throw new HTTPException(404, { message: 'Maintenance link not found' })
  const db = getDb(c.env)
  const [link] = await db.select().from(maintenanceLinks).where(eq(maintenanceLinks.tokenHash, await hashToken(token))).limit(1)
  const row = link ? await loadMaintenance(db, link.maintenanceId) : null
  if (!link || !row) throw new HTTPException(404, { message: 'Maintenance link not found' })
  return { db, link, row }
}

/** A refusal for a link that can no longer answer: 410, saying which way it is gone. */
const gone = (c: Context<AppEnv>, state: Exclude<LinkState, 'open'>) => c.json({ code: 410 as const, error: GONE_MESSAGES[state], state }, 410)

const publicView = async (db: Database, link: LinkRow, row: MaintenanceRow, now: Date) => {
  const [[appRow], [company], windows] = await Promise.all([
    db.select({ name: apps.name }).from(apps).where(eq(apps.id, row.appId)).limit(1),
    db.select({ legalName: companies.legalName, tradeName: companies.tradeName }).from(companies).where(eq(companies.id, row.companyId)).limit(1),
    windowsOf(db, [row.id]),
  ])
  const offered = windows.get(row.id) ?? []
  const chosen = offered.find((window) => window.id === row.chosenWindowId) ?? null
  const state = stateOf(link, row, now)
  const scheduledOnce = ['scheduled', 'in_progress', 'completed', 'failed'].includes(row.status)
  const decision = scheduledOnce
    ? row.autoApplied
      ? 'auto_applied'
      : 'approved'
    : link.answer === 'rejected' || (row.status === 'draft' && row.rejectedAt)
      ? 'rejected'
      : row.status === 'cancelled'
        ? 'cancelled'
        : row.status === 'no_response'
          ? 'no_response'
          : null
  const asWindow = (window: WindowRow) => ({ id: window.id, starts_at: iso(window.startsAt), ends_at: iso(window.endsAt), position: window.position, available: window.startsAt > now })
  return {
    title: row.title,
    description: row.description,
    estimated_minutes: row.estimatedMinutes,
    kind: row.kind,
    app_name: appRow?.name ?? null,
    company_name: company?.tradeName || company?.legalName || null,
    status: row.status,
    state,
    answerable: state === 'open',
    expires_at: iso(link.expiresAt),
    windows: offered.map(asWindow),
    outcome: decision
      ? {
          decision,
          window: chosen ? asWindow(chosen) : null,
          rejection_reason: decision === 'rejected' ? row.rejectionReason : null,
          responded_at: iso(row.respondedAt),
          /** Whether the answer came through this very link. */
          answered_here: link.answer !== null,
        }
      : null,
  }
}

const publicSchema = v.looseObject({ title: v.string(), state: v.string(), answerable: v.boolean() })
const goneDoc = { description: 'The link can no longer answer: `state` says why (`answered`, `closed`, `superseded` or `expired`)' }

app.get(
  '/public/maintenances/:token',
  describeRoute({
    description:
      "What a maintenance approval link shows, without a login: the maintenance's title, description and estimated duration, the app's and company's names, the windows offered (`available` while one is still in the future), and whether the link can still answer (`state`, `answerable`). Once answered — through this link or another, or applied without an answer — `outcome` says how. Unknown links are a 404; a link that can no longer answer still reads.",
    tags: ['Maintenance approval'],
    responses: { 200: { description: 'The request', content: jsonContent(dataSchema(publicSchema)) }, 404: { description: 'Unknown link' }, 429: { description: 'Too many requests' } },
  }),
  async (c) => {
    const { db, link, row } = await resolve(c)
    return c.json({ code: 200 as const, data: await publicView(db, link, row, new Date()) })
  },
)

app.post(
  '/public/maintenances/:token/approve',
  describeRoute({
    description: "Approves the maintenance in one of the windows it offers (`window_id`, still in the future), optionally with the name of who approves. The client's approvers are emailed the confirmation, and every link of the request stops answering.",
    tags: ['Maintenance approval'],
    responses: { 200: { description: 'Approved', content: jsonContent(dataSchema(publicSchema)) }, 404: { description: 'Unknown link' }, 410: goneDoc, 422: { description: 'Not one of the windows offered, or it already started' }, 429: { description: 'Too many requests' } },
  }),
  validate('json', v.object({ window_id: v.pipe(v.string(), v.uuid()), name: optionalText(120) })),
  async (c) => {
    const body = c.req.valid('json')
    const { db, link, row } = await resolve(c)
    const now = new Date()
    const state = stateOf(link, row, now)
    if (state !== 'open') return gone(c, state)
    const window = ((await windowsOf(db, [row.id])).get(row.id) ?? []).find((candidate) => candidate.id === body.window_id)
    if (!window) throw new HTTPException(422, { message: 'window_id is not one of the windows offered' })
    if (window.startsAt <= now) throw new HTTPException(422, { message: 'That window already started; choose a later one' })
    const updated = await markScheduled(c.env, db, row, window, 'approved', now, { respondedBy: link.recipientEmail, respondedByName: body.name ?? null, respondedAt: now })
    if (!updated) return gone(c, 'closed')
    await db.batch([
      db.update(maintenanceLinks).set({ answer: 'approved', answeredAt: now, invalidatedAt: now }).where(eq(maintenanceLinks.id, link.id)),
      db.insert(auditLogs).values(
        auditRow({
          event: 'maintenance.approved',
          actorEmail: link.recipientEmail,
          resourceType: 'maintenance',
          resourceId: row.id,
          ...getRequestContext(c),
          metadata: { via: 'approval_link', link_id: link.id, app_id: row.appId, name: body.name ?? null, window: { id: window.id, starts_at: iso(window.startsAt), ends_at: iso(window.endsAt) } },
        }),
      ),
    ])
    await notifyOwner(c.env, updated, 'custom_apps.maintenance_approved', {
      window: windowLabel(window),
      approved_by: body.name ? `${body.name} (${link.recipientEmail})` : link.recipientEmail,
    })
    const [after] = await db.select().from(maintenanceLinks).where(eq(maintenanceLinks.id, link.id))
    return c.json({ code: 200 as const, data: await publicView(db, after!, updated, now) })
  },
)

app.post(
  '/public/maintenances/:token/reject',
  describeRoute({
    description: `Rejects the maintenance, with a \`reason\` (required, at most ${MAINTENANCES.maxRejectionLength} characters) that is passed on so it can be rescheduled. Every link of the request stops answering.`,
    tags: ['Maintenance approval'],
    responses: { 200: { description: 'Rejected', content: jsonContent(dataSchema(publicSchema)) }, 400: { description: 'No reason' }, 404: { description: 'Unknown link' }, 410: goneDoc, 429: { description: 'Too many requests' } },
  }),
  validate('json', v.object({ reason: requiredText(MAINTENANCES.maxRejectionLength), name: optionalText(120) })),
  async (c) => {
    const body = c.req.valid('json')
    const { db, link, row } = await resolve(c)
    const now = new Date()
    const state = stateOf(link, row, now)
    if (state !== 'open') return gone(c, state)
    // Back to draft, keeping why, so it can be adjusted and offered again.
    const [updated] = await db
      .update(maintenances)
      .set({ status: 'draft', rejectionReason: body.reason, rejectedAt: now, respondedAt: now, respondedBy: link.recipientEmail, respondedByName: body.name ?? null, updatedAt: now })
      .where(and(eq(maintenances.id, row.id), eq(maintenances.status, 'pending_approval')))
      .returning()
    if (!updated) return gone(c, 'closed')
    await db.batch([
      invalidateLinks(db, row.id, now),
      db.update(maintenanceLinks).set({ answer: 'rejected', answeredAt: now, invalidatedAt: now }).where(eq(maintenanceLinks.id, link.id)),
      db.insert(auditLogs).values(
        auditRow({
          event: 'maintenance.rejected',
          actorEmail: link.recipientEmail,
          resourceType: 'maintenance',
          resourceId: row.id,
          ...getRequestContext(c),
          metadata: { via: 'approval_link', link_id: link.id, app_id: row.appId, name: body.name ?? null, reason: body.reason },
        }),
      ),
    ])
    await notifyOwner(c.env, updated, 'custom_apps.maintenance_rejected', {
      reason: body.reason.length > 280 ? `${body.reason.slice(0, 279)}…` : body.reason,
      rejected_by: body.name ? `${body.name} (${link.recipientEmail})` : link.recipientEmail,
    })
    const [after] = await db.select().from(maintenanceLinks).where(eq(maintenanceLinks.id, link.id))
    return c.json({ code: 200 as const, data: await publicView(db, after!, updated, now) })
  },
)

export { app as approval, stateOf }
export type { LinkState }
