import { renderMaintenanceNoticeEmail, renderMaintenanceRequestEmail, type MaintenanceNoticeStage } from '@franciscosolis/emails'
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { HTTPException } from 'hono/http-exception'
import { getDb, type Database } from '@/db/client'
import { apps, auditLogs, companies, installations, maintenanceLinks, maintenances, maintenanceWindows, messages, releaseReports, releases, workLogs } from '@/db/schema'
import type { Env } from '@/env'
import { MAINTENANCES, type MaintenanceStatus } from '@/lib/config'
import { iso, parseJsonArray, parseJsonObject } from '@/lib/json'
import { zonedDay } from '@/lib/time'
import { hashToken, randomToken, TOKEN_PREFIXES } from '@/lib/tokens'
import { modulesOf } from '@/services/apps'
import { auditRow } from '@/services/audit'
import { contactRecipients, graceAllows, resolveWorkLogTarget, todayIn } from '@/services/contracts'
import { formatMailInstant, formatMailTime, formatMailWindow, sendMail } from '@/services/mail'
import { publishNotification, type NotificationData, type NotificationType } from '@/services/notify'
import { normaliseArch, type ReleaseRow } from '@/services/releases'
import type { AppRow, InstallationRow } from '@/services/serialize'
import { syncApp } from '@/services/socket'

/**
 * Scheduled maintenances: work on a client's devices — usually a release installed on some of them —
 * in a window the client approved, or for a security patch, one the system chose.
 *
 * Named `maintenances` (plural) on purpose: `services/maintenance.ts` is the five-minute cron, which
 * predates this and has nothing to do with it beyond calling `runMaintenances`.
 *
 * **The timeline, all driven by the cron with an explicit `now`:**
 *
 * 1. Sent (`pending_approval`, `sends = 1`): one approval link per recipient, emailed.
 * 2. 48 hours without an answer: sent again (`sends = 2`), every earlier link invalidated.
 * 3. 48 more hours: applied in the first offered window (by position) still 24 hours away
 *    (`scheduled`, `auto_applied`), or `no_response` when none is, and the owner is told. A link also
 *    expires when the first window it offered starts; an expired request goes straight to this step.
 * 4. 24 hours before the window: the reminder email, and an in-app notice when the app has messages.
 * 5. The window starts (`in_progress`): the included installations go into `maintenance`, the release
 *    is offered to them.
 * 6. At the window's end — plus the app's health-check timeout when a release is attached — it is
 *    evaluated: every update target reported `health_ok` on the release since the start, and none
 *    rolled back or failed → `completed` (work log, closing email); anything else → `failed` (release
 *    withdrawn, owner told, failure email).
 *
 * **A security patch skips 1–3**: `/schedule` picks the first unused block within the contract's
 * `security_patch_days` (or the least used one) and emails the advance notice at once.
 *
 * **Grace pauses it** unless the lapsed contract allows `maintenance`, and suspension always does:
 * sending and scheduling answer 409, the cron neither resends, applies, reminds nor starts, and a
 * window (or a link) that runs out while paused cancels the maintenance with the pause as the reason.
 */

type MaintenanceRow = typeof maintenances.$inferSelect
type WindowRow = typeof maintenanceWindows.$inferSelect
type LinkRow = typeof maintenanceLinks.$inferSelect

/** What a run recorded, in `result_detail`. Every key is optional: the shape grows as the run goes. */
type ResultDetail = {
  /** Installations put in `maintenance` at the start. */
  installations?: string[]
  /** The override each of those had before, restored at the end unless somebody changed it since. */
  previous_overrides?: Record<string, { state_override: string | null; state_message: string | null }>
  /** Included but left alone: an installation suspended or in grace on its own. */
  skipped?: Array<{ id: string; reason: string }>
  /** Installations expected to install the release and report `health_ok`. */
  targets?: string[]
  /** Included and already running the release's version: nothing to install. */
  already_on_version?: string[]
  /** Included but on another channel, platform or architecture than the release: not offered it. */
  off_line?: string[]
  /** How the release was extended to the targets at the start. */
  release?: { id: string; version: string; status_before: string; published_by_maintenance: boolean; added_installations: string[] }
  /** Why it failed. */
  failure?: { reason: string; installations?: Array<{ id: string; status: string }> }
  /** What the person closing it by hand wrote. */
  note?: string
  /** Recipients the cron could not email. */
  mail_failures?: Array<{ stage: string; recipients: string[] }>
  withdrawn?: boolean
}

/** The language client-facing copy is written in: the clients are Chilean. English sits beside it in the templates. */
const MAINTENANCE_LOCALE = 'es' as const

/** `created_by` on the in-app notices a maintenance posts, so cancelling or finishing it ends them. */
const noticeAuthor = (maintenanceId: string) => `maintenance:${maintenanceId}`

const detailOf = (row: Pick<MaintenanceRow, 'resultDetail'>) => parseJsonObject<ResultDetail>(row.resultDetail) ?? {}

const seconds = (date: Date) => Math.floor(date.getTime() / 1000)
const hours = (count: number) => count * 3600 * 1000

/* ── Loading and serialising ─────────────────────────────────────────────── */

const windowsOf = async (db: Database, ids: string[]) => {
  const map = new Map<string, WindowRow[]>()
  if (ids.length === 0) return map
  const rows = await db.select().from(maintenanceWindows).where(inArray(maintenanceWindows.maintenanceId, ids)).orderBy(asc(maintenanceWindows.position), asc(maintenanceWindows.startsAt))
  for (const row of rows) map.set(row.maintenanceId, [...(map.get(row.maintenanceId) ?? []), row])
  return map
}

/** The links of each maintenance's latest send: who it was last sent to, and until when. */
const latestLinks = async (db: Database, rows: Pick<MaintenanceRow, 'id' | 'sends'>[]) => {
  const map = new Map<string, LinkRow[]>()
  const sent = rows.filter((row) => row.sends > 0)
  if (sent.length === 0) return map
  const links = await db
    .select()
    .from(maintenanceLinks)
    .where(and(inArray(maintenanceLinks.maintenanceId, sent.map((row) => row.id)), sql`${maintenanceLinks.send} = (SELECT MAX(x.send) FROM maintenance_links x WHERE x.maintenance_id = "maintenance_links"."maintenance_id")`))
  for (const link of links) map.set(link.maintenanceId, [...(map.get(link.maintenanceId) ?? []), link])
  return map
}

const toWindow = (row: WindowRow, chosenId: string | null) => ({
  id: row.id,
  starts_at: iso(row.startsAt),
  ends_at: iso(row.endsAt),
  source: row.source,
  position: row.position,
  chosen: row.id === chosenId,
})

type ReleaseBrief = Pick<ReleaseRow, 'id' | 'version' | 'channel' | 'platform' | 'arch' | 'status'>

type Extra = {
  appName?: string | null
  companyName?: string | null
  release?: ReleaseBrief | null
  windows?: WindowRow[]
  links?: LinkRow[]
}

const toMaintenance = (row: MaintenanceRow, extra: Extra = {}) => {
  const windows = extra.windows ?? []
  const chosen = windows.find((window) => window.id === row.chosenWindowId) ?? null
  const links = extra.links ?? []
  const detail = detailOf(row)
  const installationIds = parseJsonArray<string>(row.installationIds)
  return {
    id: row.id,
    app_id: row.appId,
    app_name: extra.appName ?? null,
    company_id: row.companyId,
    company_name: extra.companyName ?? null,
    kind: row.kind,
    title: row.title,
    description: row.description,
    estimated_minutes: row.estimatedMinutes,
    release_id: row.releaseId,
    release: extra.release
      ? { id: extra.release.id, version: extra.release.version, channel: extra.release.channel, platform: extra.release.platform, arch: extra.release.arch, status: extra.release.status }
      : null,
    installation_ids: installationIds,
    /** No installations named: every active installation of the app. */
    all_installations: installationIds.length === 0,
    status: row.status as MaintenanceStatus,
    /** A draft the client sent back: `rejection_reason` says why. */
    rejected: row.status === 'draft' && row.rejectedAt !== null,
    rejection_reason: row.rejectionReason,
    rejected_at: iso(row.rejectedAt),
    sends: row.sends,
    last_sent_at: iso(row.lastSentAt),
    /** Who the latest request went to. */
    recipients: links.map((link) => link.recipientEmail),
    /** When the latest request's links stop working: the first window's start. */
    link_expires_at: links.length > 0 ? iso(links[0]!.expiresAt) : null,
    windows: windows.map((window) => toWindow(window, row.chosenWindowId)),
    chosen_window: chosen ? toWindow(chosen, row.chosenWindowId) : null,
    scheduled_at: iso(row.scheduledAt),
    auto_applied: row.autoApplied,
    responded_by: row.respondedBy,
    responded_by_name: row.respondedByName,
    responded_at: iso(row.respondedAt),
    /** The address that approved it through its link, or null. */
    approved_by: row.respondedBy && (!row.rejectedAt || (row.respondedAt !== null && row.respondedAt > row.rejectedAt)) ? row.respondedBy : null,
    reminder_sent_at: iso(row.reminderSentAt),
    started_at: iso(row.startedAt),
    finished_at: iso(row.finishedAt),
    result: row.result,
    result_detail: detail,
    closed_by: row.closedBy,
    work_log_id: row.workLogId,
    cancelled_at: iso(row.cancelledAt),
    cancelled_by: row.cancelledBy,
    cancel_reason: row.cancelReason,
    created_by: row.createdBy,
    updated_by: row.updatedBy,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  }
}

type MaintenanceView = ReturnType<typeof toMaintenance>

/** Serialises maintenances with their app, company, release, windows and latest recipients, in five statements however many. */
const serializeMaintenances = async (db: Database, rows: MaintenanceRow[]): Promise<MaintenanceView[]> => {
  if (rows.length === 0) return []
  const appIds = [...new Set(rows.map((row) => row.appId))]
  const companyIds = [...new Set(rows.map((row) => row.companyId))]
  const releaseIds = [...new Set(rows.map((row) => row.releaseId).filter((id): id is string => id !== null))]
  const [appRows, companyRows, releaseRows, windows, links] = await Promise.all([
    db.select({ id: apps.id, name: apps.name }).from(apps).where(inArray(apps.id, appIds)),
    db.select({ id: companies.id, legalName: companies.legalName, tradeName: companies.tradeName }).from(companies).where(inArray(companies.id, companyIds)),
    releaseIds.length > 0
      ? db.select({ id: releases.id, version: releases.version, channel: releases.channel, platform: releases.platform, arch: releases.arch, status: releases.status }).from(releases).where(inArray(releases.id, releaseIds))
      : Promise.resolve([]),
    windowsOf(db, rows.map((row) => row.id)),
    latestLinks(db, rows),
  ])
  const appName = new Map(appRows.map((row) => [row.id, row.name]))
  const companyName = new Map(companyRows.map((row) => [row.id, row.tradeName || row.legalName]))
  const release = new Map(releaseRows.map((row) => [row.id, row]))
  return rows.map((row) =>
    toMaintenance(row, {
      appName: appName.get(row.appId) ?? null,
      companyName: companyName.get(row.companyId) ?? null,
      release: row.releaseId ? (release.get(row.releaseId) ?? null) : null,
      windows: windows.get(row.id) ?? [],
      links: links.get(row.id) ?? [],
    }),
  )
}

const loadMaintenance = async (db: Database, id: string) => {
  const [row] = await db.select().from(maintenances).where(eq(maintenances.id, id)).limit(1)
  return row ?? null
}

const viewOf = async (db: Database, id: string) => {
  const row = await loadMaintenance(db, id)
  return row ? ((await serializeMaintenances(db, [row]))[0] ?? null) : null
}

/* ── What a maintenance touches ──────────────────────────────────────────── */

/** The installations a maintenance includes right now: the named ones still active, or every active one. */
const includedInstallations = async (db: Database, row: Pick<MaintenanceRow, 'appId' | 'installationIds'>): Promise<InstallationRow[]> => {
  const ids = parseJsonArray<string>(row.installationIds)
  return db
    .select()
    .from(installations)
    .where(
      and(
        eq(installations.appId, row.appId),
        eq(installations.status, 'active'),
        ids.length > 0 ? sql`${installations.id} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))` : undefined,
      ),
    )
}

/** Whether a release's line (channel, platform, architecture) is an installation's — whether the offer can reach it. */
const onReleaseLine = (release: Pick<ReleaseRow, 'channel' | 'platform' | 'arch'>, installation: Pick<InstallationRow, 'channel' | 'platform' | 'arch'>) =>
  release.channel === installation.channel &&
  release.platform === installation.platform &&
  (release.arch === 'any' || release.arch === 'universal' || normaliseArch(installation.arch) === release.arch)

/** Who approves a maintenance: the company's `maintenance_approver` contacts, else the primary contact, else anyone. */
const approvalRecipients = (db: Database, companyId: string) => contactRecipients(db, companyId, ['maintenance_approver'])

/**
 * Why a maintenance of this app cannot go ahead right now, or null. Suspension always pauses it; grace
 * does unless the contract that lapsed allows `maintenance` — an app put in grace by hand has no
 * contract to allow it.
 */
const pauseOf = async (db: Database, app: Pick<AppRow, 'id' | 'state'>): Promise<'grace' | 'suspended' | null> => {
  if (app.state === 'suspended') return 'suspended'
  if (app.state === 'grace' && !(await graceAllows(db, app.id, 'maintenance'))) return 'grace'
  return null
}

const assertNotPaused = async (db: Database, app: Pick<AppRow, 'id' | 'state'>) => {
  const pause = await pauseOf(db, app)
  if (pause === 'suspended') throw new HTTPException(409, { message: 'The app is suspended: maintenances are paused until it is reactivated' })
  if (pause === 'grace') throw new HTTPException(409, { message: "The app is in grace and its contract does not keep maintenances running: they are paused until it is renewed" })
}

/* ── Mail ────────────────────────────────────────────────────────────────── */

type MailContext = { appName: string; companyName: string }

const mailContext = async (db: Database, row: Pick<MaintenanceRow, 'appId' | 'companyId'>): Promise<MailContext> => {
  const [[app], [company]] = await Promise.all([
    db.select({ name: apps.name }).from(apps).where(eq(apps.id, row.appId)).limit(1),
    db.select({ legalName: companies.legalName, tradeName: companies.tradeName }).from(companies).where(eq(companies.id, row.companyId)).limit(1),
  ])
  return { appName: app?.name ?? '', companyName: company?.tradeName || company?.legalName || '' }
}

const releaseVersion = async (db: Database, releaseId: string | null) => {
  if (!releaseId) return null
  const [row] = await db.select({ version: releases.version }).from(releases).where(eq(releases.id, releaseId)).limit(1)
  return row?.version ?? null
}

/**
 * Emails a notice to the client's approvers. Best effort: a notice that fails is logged and recorded
 * in `result_detail.mail_failures`, never retried and never failing what it reports — the maintenance
 * happened (or will) whether or not the mail went out. Answers who it reached.
 */
const sendNotice = async (env: Env, db: Database, row: MaintenanceRow, window: Pick<WindowRow, 'startsAt' | 'endsAt'>, stage: MaintenanceNoticeStage, options: { version?: string | null } = {}) => {
  const recipients = await approvalRecipients(db, row.companyId)
  if (recipients.length === 0) return { delivered: [] as string[], failed: [] as string[] }
  const context = await mailContext(db, row)
  const rendered = await renderMaintenanceNoticeEmail({
    stage,
    companyName: context.companyName,
    appName: context.appName,
    title: row.title,
    description: row.description,
    estimatedMinutes: row.estimatedMinutes,
    window: formatMailWindow(window.startsAt, window.endsAt, MAINTENANCE_LOCALE),
    approvedBy: row.respondedByName ? `${row.respondedByName} (${row.respondedBy})` : row.respondedBy,
    version: options.version !== undefined ? options.version : await releaseVersion(db, row.releaseId),
    locale: MAINTENANCE_LOCALE,
    brandName: env.MAIL_FROM_NAME,
  })
  try {
    await sendMail(env, { to: recipients, ...rendered })
    return { delivered: recipients, failed: [] as string[] }
  } catch (error) {
    console.error('failed to email a maintenance notice', row.id, stage, error)
    const detail = detailOf((await loadMaintenance(db, row.id)) ?? row)
    detail.mail_failures = [...(detail.mail_failures ?? []), { stage, recipients }]
    await db.update(maintenances).set({ resultDetail: JSON.stringify(detail) }).where(eq(maintenances.id, row.id))
    return { delivered: [] as string[], failed: recipients }
  }
}

/** The account that created the maintenance hears about the client's answer and the outcome. */
const notifyOwner = async (env: Env, row: MaintenanceRow, type: NotificationType, data: NotificationData = {}) => {
  if (!row.createdById) return false
  const context = await mailContext(getDb(env), row)
  return publishNotification(env, {
    type,
    user: { id: row.createdById, email: row.createdBy },
    url: `/custom-apps/maintenances/${row.id}`,
    data: { maintenance_id: row.id, title: row.title, app_name: context.appName, company_name: context.companyName, ...data },
  })
}

/** `YYYY-MM-DD HH:MM–HH:MM` on Santiago's clock: language-neutral, for a notification's data. */
const windowLabel = (window: Pick<WindowRow, 'startsAt' | 'endsAt'>) => `${zonedDay(window.startsAt)} ${formatMailTime(window.startsAt, 'es')}–${formatMailTime(window.endsAt, 'es')}`

/* ── Sending the approval request ────────────────────────────────────────── */

/**
 * Emails the approval request: a fresh link for each recipient, each expiring when the first window
 * starts. Earlier links are invalidated only once at least one new one was delivered, so a mail outage
 * never leaves the client with nothing that works. Answers who got it and who did not, and throws 502
 * when nobody did (the caller's state is left as it was).
 */
const sendRequest = async (env: Env, db: Database, row: MaintenanceRow, now: Date) => {
  const windows = (await windowsOf(db, [row.id])).get(row.id) ?? []
  if (windows.length === 0) throw new HTTPException(422, { message: 'Offer at least one window before sending' })
  const recipients = await approvalRecipients(db, row.companyId)
  if (recipients.length === 0) throw new HTTPException(422, { message: 'The company has no contact with an email address to send the request to' })
  const expiresAt = new Date(Math.min(...windows.map((window) => window.startsAt.getTime())))
  const send = (row.status === 'pending_approval' ? row.sends : 0) + 1
  const reminder = send > 1
  // Links are numbered across every round of a maintenance (a rejection or no answer starts a new
  // round at `sends = 1`), so "the latest links" and "every earlier link" are always well defined.
  const [{ sequence } = { sequence: 0 }] = await db
    .select({ sequence: sql<number>`COALESCE(MAX(${maintenanceLinks.send}), 0)` })
    .from(maintenanceLinks)
    .where(eq(maintenanceLinks.maintenanceId, row.id))
  const linkSend = Number(sequence) + 1
  const context = await mailContext(db, row)
  const formatted = windows.map((window) => formatMailWindow(window.startsAt, window.endsAt, MAINTENANCE_LOCALE))
  const delivered: string[] = []
  const failed: string[] = []
  const created: string[] = []
  for (const recipient of recipients) {
    const token = randomToken(TOKEN_PREFIXES.maintenance, 32)
    const linkId = crypto.randomUUID()
    await db.insert(maintenanceLinks).values({ id: linkId, maintenanceId: row.id, tokenHash: await hashToken(token), recipientEmail: recipient, send: linkSend, expiresAt })
    created.push(linkId)
    const rendered = await renderMaintenanceRequestEmail({
      companyName: context.companyName,
      appName: context.appName,
      title: row.title,
      description: row.description,
      estimatedMinutes: row.estimatedMinutes,
      windows: formatted,
      url: `${env.MAINTENANCE_LINK_BASE_URL.replace(/\/+$/, '')}/${token}`,
      expiresAt: formatMailInstant(expiresAt, MAINTENANCE_LOCALE),
      reminder,
      locale: MAINTENANCE_LOCALE,
      brandName: env.MAIL_FROM_NAME,
    })
    try {
      await sendMail(env, { to: [recipient], ...rendered })
      delivered.push(recipient)
    } catch (error) {
      console.error('failed to email a maintenance request', row.id, error)
      failed.push(recipient)
      await db.update(maintenanceLinks).set({ invalidatedAt: now }).where(eq(maintenanceLinks.id, linkId))
    }
  }
  if (delivered.length === 0) {
    throw new HTTPException(502, { message: 'The approval request could not be emailed to anybody; nothing was sent. Try again later.' })
  }
  await db.batch([
    db
      .update(maintenanceLinks)
      .set({ invalidatedAt: now })
      .where(and(eq(maintenanceLinks.maintenanceId, row.id), sql`${maintenanceLinks.send} < ${linkSend}`, isNull(maintenanceLinks.invalidatedAt))),
    db.update(maintenances).set({ status: 'pending_approval', sends: send, lastSentAt: now, updatedAt: now }).where(eq(maintenances.id, row.id)),
  ])
  return { send, delivered, failed, expiresAt }
}

/** Closes every link of a maintenance that could still answer. */
const invalidateLinks = (db: Database, maintenanceId: string, now: Date) =>
  db.update(maintenanceLinks).set({ invalidatedAt: now }).where(and(eq(maintenanceLinks.maintenanceId, maintenanceId), isNull(maintenanceLinks.invalidatedAt)))

/* ── Scheduling ──────────────────────────────────────────────────────────── */

type ScheduleHow = 'approved' | 'auto_applied' | 'security'

/**
 * Fixes a maintenance in `window` and emails the confirmation. The update is a compare-and-swap on
 * the status `row` was read in, so two answers racing schedule it once. Answers the row after, or null
 * when it had moved on meanwhile.
 */
const markScheduled = async (
  env: Env,
  db: Database,
  row: MaintenanceRow,
  window: WindowRow,
  how: ScheduleHow,
  now: Date,
  fields: Partial<typeof maintenances.$inferInsert> = {},
) => {
  const [updated] = await db
    .update(maintenances)
    .set({ status: 'scheduled', chosenWindowId: window.id, scheduledAt: now, autoApplied: how === 'auto_applied', reminderSentAt: null, updatedAt: now, ...fields })
    .where(and(eq(maintenances.id, row.id), eq(maintenances.status, row.status)))
    .returning()
  if (!updated) return null
  await invalidateLinks(db, row.id, now)
  await sendNotice(env, db, updated, window, how)
  return updated
}

/** The first offered window, by position, that starts at least `minLeadHours` after `now`. */
const firstEligibleWindow = (windows: WindowRow[], now: Date) =>
  [...windows]
    .sort((a, b) => a.position - b.position || a.startsAt.getTime() - b.startsAt.getTime())
    .find((window) => window.startsAt.getTime() >= now.getTime() + hours(MAINTENANCES.minLeadHours)) ?? null

/**
 * Nobody answered: applies it in the first eligible window, or marks it `no_response` and tells the
 * owner when there is none. With no actor and `automatic: true` either way.
 */
const autoApply = async (env: Env, db: Database, row: MaintenanceRow, now: Date, cause: 'no_answer' | 'link_expired') => {
  const windows = (await windowsOf(db, [row.id])).get(row.id) ?? []
  const window = firstEligibleWindow(windows, now)
  if (window) {
    const updated = await markScheduled(env, db, row, window, 'auto_applied', now)
    if (!updated) return null
    await db.insert(auditLogs).values(
      auditRow({ event: 'maintenance.auto_applied', resourceType: 'maintenance', resourceId: row.id, metadata: { automatic: true, app_id: row.appId, cause, sends: row.sends, window: { id: window.id, starts_at: iso(window.startsAt), ends_at: iso(window.endsAt) } } }),
    )
    return 'auto_applied' as const
  }
  const [updated] = await db
    .update(maintenances)
    .set({ status: 'no_response', updatedAt: now })
    .where(and(eq(maintenances.id, row.id), eq(maintenances.status, 'pending_approval')))
    .returning()
  if (!updated) return null
  await invalidateLinks(db, row.id, now)
  await db.insert(auditLogs).values(auditRow({ event: 'maintenance.no_response', resourceType: 'maintenance', resourceId: row.id, metadata: { automatic: true, app_id: row.appId, cause, sends: row.sends } }))
  await notifyOwner(env, updated, 'custom_apps.maintenance_no_response', { sends: row.sends })
  return 'no_response' as const
}

/* ── Cancelling ──────────────────────────────────────────────────────────── */

/** Ends the in-app notices a maintenance posted. */
const endNotices = (db: Database, maintenanceId: string, now: Date) =>
  db
    .update(messages)
    .set({ endsAt: now, updatedAt: now })
    .where(and(eq(messages.createdBy, noticeAuthor(maintenanceId)), or(isNull(messages.endsAt), gt(messages.endsAt, now))))

const CANCELLABLE: MaintenanceStatus[] = ['draft', 'pending_approval', 'scheduled', 'no_response']

/** Cancels a maintenance that has not started: its links close and its in-app notices end. */
const cancelMaintenance = async (env: Env, db: Database, row: MaintenanceRow, input: { reason: string | null; actor: { actorEmail: string | null; actorId?: string | null; ip?: string | null; userAgent?: string | null } }, now: Date) => {
  if (!CANCELLABLE.includes(row.status as MaintenanceStatus)) {
    throw new HTTPException(409, { message: row.status === 'in_progress' ? 'A maintenance in progress is closed with /complete or /fail, not cancelled' : `A ${row.status} maintenance cannot be cancelled` })
  }
  const [updated] = await db
    .update(maintenances)
    .set({ status: 'cancelled', cancelledAt: now, cancelledBy: input.actor.actorEmail, cancelReason: input.reason, updatedAt: now, updatedBy: input.actor.actorEmail })
    .where(and(eq(maintenances.id, row.id), eq(maintenances.status, row.status)))
    .returning()
  if (!updated) throw new HTTPException(409, { message: 'The maintenance changed while saving; reload and try again' })
  await db.batch([
    invalidateLinks(db, row.id, now),
    endNotices(db, row.id, now),
    db.insert(auditLogs).values(
      auditRow({ event: 'maintenance.cancelled', resourceType: 'maintenance', resourceId: row.id, ...input.actor, metadata: { automatic: input.actor.actorEmail === null, app_id: row.appId, before: { status: row.status }, reason: input.reason } }),
    ),
  ])
  await syncApp(env, row.appId)
  return updated
}

/* ── The 24-hour reminder ────────────────────────────────────────────────── */

const NOTICE_COPY = {
  en: {
    title: 'Scheduled maintenance',
    body: (window: string, title: string) => `A maintenance is scheduled for ${window}: ${title}. The app may be unavailable during that time.`,
    state: (end: string) => `Maintenance in progress. Estimated end: ${end}.`,
  },
  es: {
    title: 'Mantención programada',
    body: (window: string, title: string) => `Hay una mantención programada para el ${window}: ${title}. La app puede no estar disponible durante ese tiempo.`,
    state: (end: string) => `Mantención en curso. Fin estimado: ${end}.`,
  },
} as const

/**
 * The reminder, about 24 hours before the window: an email, unless the client was told when it was
 * scheduled within those 24 hours anyway, and an in-app notice on the included installations when the
 * app has the `messages` module — app-wide when it includes all of them, one per installation when it
 * names some. Both end when the maintenance does.
 */
const remind = async (env: Env, db: Database, row: MaintenanceRow, app: AppRow, window: WindowRow, now: Date) => {
  const [claimed] = await db
    .update(maintenances)
    .set({ reminderSentAt: now, updatedAt: now })
    .where(and(eq(maintenances.id, row.id), eq(maintenances.status, 'scheduled'), isNull(maintenances.reminderSentAt)))
    .returning()
  if (!claimed) return false
  const emailed = row.scheduledAt === null || row.scheduledAt.getTime() < window.startsAt.getTime() - hours(MAINTENANCES.reminderBeforeHours)
  const mail = emailed ? await sendNotice(env, db, claimed, window, 'reminder') : { delivered: [], failed: [] }
  let posted = 0
  if (modulesOf(app).includes('messages')) {
    const copy = NOTICE_COPY[MAINTENANCE_LOCALE]
    const named = parseJsonArray<string>(row.installationIds)
    const targets = named.length === 0 ? [{ scope: 'app', scopeValue: '' }] : (await includedInstallations(db, row)).map((installation) => ({ scope: 'installation', scopeValue: installation.id }))
    const text = formatMailWindow(window.startsAt, window.endsAt, MAINTENANCE_LOCALE)
    const inserts = targets.map((target) =>
          db.insert(messages).values({
            id: crypto.randomUUID(),
            appId: row.appId,
            title: copy.title,
            body: copy.body(text, row.title),
            severity: 'warning',
            display: 'banner',
            scope: target.scope,
            scopeValue: target.scopeValue,
            startsAt: now,
            endsAt: window.endsAt,
            createdBy: noticeAuthor(row.id),
          }),
    )
    const [first, ...rest] = inserts
    if (first) {
      await db.batch([first, ...rest])
      posted = inserts.length
    }
  }
  await db.insert(auditLogs).values(
    auditRow({ event: 'maintenance.reminded', resourceType: 'maintenance', resourceId: row.id, metadata: { automatic: true, app_id: row.appId, emailed: mail.delivered, email_failed: mail.failed, in_app_notices: posted } }),
  )
  if (posted > 0) await syncApp(env, row.appId)
  return true
}

/* ── Starting ────────────────────────────────────────────────────────────── */

/**
 * The window started: the included installations go into `maintenance` (each one's previous override
 * remembered, so finishing restores it), and the release — if any — is made to reach exactly the
 * update targets. A draft is published at 0 % with only the targets named in `rollout_installations`;
 * a published release keeps its rollout and gets the targets added to it. Either way nobody outside
 * the maintenance is offered it because of the maintenance. A release paused or withdrawn since the
 * maintenance was planned fails it before anything is touched.
 */
const start = async (env: Env, db: Database, row: MaintenanceRow, app: AppRow, window: WindowRow, now: Date) => {
  const release = row.releaseId ? ((await db.select().from(releases).where(eq(releases.id, row.releaseId)).limit(1))[0] ?? null) : null
  if (release && release.status !== 'draft' && release.status !== 'published') {
    const [claimed] = await db.update(maintenances).set({ status: 'in_progress', startedAt: now, updatedAt: now }).where(and(eq(maintenances.id, row.id), eq(maintenances.status, 'scheduled'))).returning()
    if (!claimed) return false
    await finish(env, db, claimed, { success: false, reason: 'release_unavailable' }, null, now)
    return true
  }

  const included = await includedInstallations(db, row)
  const skipped = included.filter((installation) => installation.stateOverride === 'suspended' || installation.stateOverride === 'grace')
  const affected = included.filter((installation) => !skipped.includes(installation))
  const detail: ResultDetail = {
    installations: affected.map((installation) => installation.id),
    previous_overrides: Object.fromEntries(affected.map((installation) => [installation.id, { state_override: installation.stateOverride, state_message: installation.stateMessage }])),
    skipped: skipped.map((installation) => ({ id: installation.id, reason: installation.stateOverride! })),
  }

  const statements: BatchItem<'sqlite'>[] = []
  if (release) {
    const onLine = affected.filter((installation) => onReleaseLine(release, installation))
    const current = onLine.filter((installation) => installation.appVersion === release.version)
    const targets = onLine.filter((installation) => installation.appVersion !== release.version)
    detail.targets = targets.map((installation) => installation.id)
    detail.already_on_version = current.map((installation) => installation.id)
    detail.off_line = affected.filter((installation) => !onLine.includes(installation)).map((installation) => installation.id)
    const reach = parseJsonArray<string>(release.rolloutInstallations)
    const added = detail.targets.filter((id) => !reach.includes(id))
    detail.release = { id: release.id, version: release.version, status_before: release.status, published_by_maintenance: release.status === 'draft', added_installations: added }
    if (release.status === 'draft') {
      statements.push(
        db
          .update(releases)
          .set({
            status: 'published',
            rolloutPercent: 0,
            rolloutInstallations: JSON.stringify(detail.targets),
            publishedAt: now,
            publishedBy: noticeAuthor(row.id),
            statusChangedAt: now,
            statusReason: JSON.stringify({ by: null, automatic: true, reason: `maintenance ${row.title}`, maintenance_id: row.id }),
            updatedAt: now,
          })
          .where(and(eq(releases.id, release.id), eq(releases.status, 'draft'))),
        db.insert(auditLogs).values(
          auditRow({ event: 'release.published', resourceType: 'app', resourceId: row.appId, metadata: { automatic: true, maintenance_id: row.id, release_id: release.id, version: release.version, rollout_percent: 0, installations: detail.targets.length } }),
        ),
      )
    } else if (added.length > 0) {
      statements.push(
        db.update(releases).set({ rolloutInstallations: JSON.stringify([...reach, ...added]), updatedAt: now }).where(eq(releases.id, release.id)),
        db.insert(auditLogs).values(
          auditRow({ event: 'release.rollout_changed', resourceType: 'app', resourceId: row.appId, metadata: { automatic: true, maintenance_id: row.id, release_id: release.id, version: release.version, added_installations: added } }),
        ),
      )
    }
  }

  const stateMessage = NOTICE_COPY[MAINTENANCE_LOCALE].state(formatMailInstant(window.endsAt, MAINTENANCE_LOCALE))
  const [claimed] = await db
    .update(maintenances)
    .set({ status: 'in_progress', startedAt: now, resultDetail: JSON.stringify(detail), updatedAt: now })
    .where(and(eq(maintenances.id, row.id), eq(maintenances.status, 'scheduled')))
    .returning()
  if (!claimed) return false
  await db.batch([
    db.insert(auditLogs).values(
      auditRow({
        event: 'maintenance.started',
        resourceType: 'maintenance',
        resourceId: row.id,
        metadata: { automatic: true, app_id: row.appId, window: { id: window.id, starts_at: iso(window.startsAt), ends_at: iso(window.endsAt) }, installations: detail.installations, skipped: detail.skipped, targets: detail.targets ?? null, release: detail.release ?? null },
      }),
    ),
    ...(affected.length > 0
      ? [
          db
            .update(installations)
            .set({ stateOverride: 'maintenance', stateMessage, updatedAt: now })
            .where(sql`${installations.id} IN (SELECT value FROM json_each(${JSON.stringify(detail.installations)}))`),
        ]
      : []),
    ...statements,
  ])
  await syncApp(env, row.appId)
  return true
}

/* ── Evaluating and finishing ────────────────────────────────────────────── */

/** When an in-progress maintenance is judged: the window's end, plus the app's health-check timeout when a release is attached. */
const evaluationDue = (row: Pick<MaintenanceRow, 'releaseId'>, window: Pick<WindowRow, 'endsAt'>, app: Pick<AppRow, 'updateHealthTimeoutSeconds'>) =>
  new Date(window.endsAt.getTime() + (row.releaseId ? app.updateHealthTimeoutSeconds * 1000 : 0))

/**
 * Whether the release reached every update target: a `health_ok` from each since the start, and no
 * `rolled_back` or `failed` from any. Answers the targets that are not fine and what they last said.
 */
const healthOf = async (db: Database, row: MaintenanceRow) => {
  const detail = detailOf(row)
  const targets = detail.targets ?? []
  if (!row.releaseId || targets.length === 0) return { ok: true, failing: [] as Array<{ id: string; status: string }> }
  const reports = await db
    .select({ installationId: releaseReports.installationId, status: releaseReports.status })
    .from(releaseReports)
    .where(
      and(
        eq(releaseReports.releaseId, row.releaseId),
        sql`${releaseReports.createdAt} >= ${seconds(row.startedAt ?? new Date(0))}`,
        sql`${releaseReports.installationId} IN (SELECT value FROM json_each(${JSON.stringify(targets)}))`,
      ),
    )
    .orderBy(asc(releaseReports.id))
  const failing: Array<{ id: string; status: string }> = []
  for (const id of targets) {
    const own = reports.filter((report) => report.installationId === id)
    const bad = own.find((report) => report.status === 'rolled_back' || report.status === 'failed')
    if (bad) failing.push({ id, status: bad.status })
    else if (!own.some((report) => report.status === 'health_ok')) failing.push({ id, status: own.at(-1)?.status ?? 'no_report' })
  }
  return { ok: failing.length === 0, failing }
}

/** Logs the hours of a completed maintenance, filed like any other entry; a closed cycle moves it to today. */
const logWork = async (db: Database, row: MaintenanceRow, window: Pick<WindowRow, 'startsAt'>, now: Date) => {
  const today = todayIn(now)
  let occurredOn = zonedDay(window.startsAt)
  if (occurredOn > today) occurredOn = today
  let target: { contractId: string | null; cycleId: string | null }
  try {
    target = await resolveWorkLogTarget(db, { companyId: row.companyId, appId: row.appId, occurredOn, day: today })
  } catch (error) {
    if (!(error instanceof HTTPException)) throw error
    if (error.status === 409 && occurredOn !== today) {
      // The window's day closed with its cycle: the work counts on the cycle running now instead.
      occurredOn = today
      target = await resolveWorkLogTarget(db, { companyId: row.companyId, appId: row.appId, occurredOn, day: today }).catch(() => ({ contractId: null, cycleId: null }))
    } else {
      target = { contractId: null, cycleId: null }
    }
  }
  const id = crypto.randomUUID()
  await db.insert(workLogs).values({
    id,
    companyId: row.companyId,
    appId: row.appId,
    contractId: target.contractId,
    cycleId: target.cycleId,
    occurredOn,
    minutes: row.estimatedMinutes,
    kind: 'maintenance',
    description: row.title,
    maintenanceId: row.id,
    createdBy: null,
  })
  await db.insert(auditLogs).values(auditRow({ event: 'work_log.created', resourceType: 'company', resourceId: row.companyId, metadata: { automatic: true, work_log_id: id, maintenance_id: row.id, minutes: row.estimatedMinutes, occurred_on: occurredOn, contract_id: target.contractId, cycle_id: target.cycleId } }))
  return id
}

/** Withdraws a failed maintenance's release, as `/withdraw` would: the devices on it are offered the earlier version back. */
const withdrawRelease = async (db: Database, row: MaintenanceRow, now: Date) => {
  if (!row.releaseId) return false
  const [release] = await db.select().from(releases).where(eq(releases.id, row.releaseId)).limit(1)
  if (!release || (release.status !== 'published' && release.status !== 'paused')) return false
  const reason = `maintenance ${row.title} failed health check`
  const [updated] = await db
    .update(releases)
    .set({ status: 'withdrawn', statusChangedAt: now, statusReason: JSON.stringify({ by: null, automatic: true, reason, maintenance_id: row.id }), updatedAt: now })
    .where(and(eq(releases.id, release.id), eq(releases.status, release.status)))
    .returning()
  if (!updated) return false
  await db.insert(auditLogs).values(
    auditRow({ event: 'release.withdrawn', resourceType: 'app', resourceId: row.appId, metadata: { automatic: true, maintenance_id: row.id, release_id: release.id, version: release.version, before: { status: release.status }, after: { status: 'withdrawn' }, reason } }),
  )
  return true
}

type Outcome = { success: boolean; reason?: string; note?: string | null; failing?: Array<{ id: string; status: string }> }

/**
 * Ends an in-progress maintenance: the overrides it set are restored (only where they still say
 * `maintenance` — somebody may have changed one by hand meanwhile), its in-app notices end, and then
 * either the hours are logged and the client told it went well, or the release is withdrawn, the owner
 * told and the client told the devices stayed on the version they had. `actor` is null for the cron.
 */
const finish = async (env: Env, db: Database, row: MaintenanceRow, outcome: Outcome, actor: { actorEmail: string | null; actorId?: string | null; ip?: string | null; userAgent?: string | null } | null, now: Date) => {
  const detail = detailOf(row)
  if (outcome.note) detail.note = outcome.note
  if (!outcome.success) detail.failure = { reason: outcome.reason ?? 'failed', ...(outcome.failing ? { installations: outcome.failing } : {}) }
  const [claimed] = await db
    .update(maintenances)
    .set({
      status: outcome.success ? 'completed' : 'failed',
      result: outcome.success ? 'succeeded' : 'failed',
      resultDetail: JSON.stringify(detail),
      finishedAt: now,
      closedBy: actor?.actorEmail ?? null,
      updatedAt: now,
    })
    .where(and(eq(maintenances.id, row.id), eq(maintenances.status, 'in_progress')))
    .returning()
  if (!claimed) return null

  const restores = Object.entries(detail.previous_overrides ?? {}).map(([id, previous]) =>
    db
      .update(installations)
      .set({ stateOverride: previous.state_override, stateMessage: previous.state_message, updatedAt: now })
      .where(and(eq(installations.id, id), eq(installations.stateOverride, 'maintenance'))),
  )
  await db.batch([endNotices(db, row.id, now), ...restores])

  const [window] = await db.select().from(maintenanceWindows).where(eq(maintenanceWindows.id, row.chosenWindowId ?? '')).limit(1)
  let final = claimed
  if (outcome.success) {
    const workLogId = window ? await logWork(db, claimed, window, now) : null
    if (workLogId) [final] = (await db.update(maintenances).set({ workLogId }).where(eq(maintenances.id, row.id)).returning()) as [MaintenanceRow]
    await db.insert(auditLogs).values(
      auditRow({ event: 'maintenance.completed', resourceType: 'maintenance', resourceId: row.id, ...(actor ?? {}), metadata: { automatic: actor === null, app_id: row.appId, work_log_id: workLogId, note: outcome.note ?? null } }),
    )
    if (window) await sendNotice(env, db, final, window, 'completed')
    await notifyOwner(env, final, 'custom_apps.maintenance_completed', { minutes: row.estimatedMinutes })
  } else {
    // Only a release the maintenance extended is withdrawn: one that was already paused or withdrawn
    // when the window started (`release_unavailable`) was never offered because of it.
    const withdrawn = detail.release ? await withdrawRelease(db, claimed, now) : false
    if (withdrawn) {
      detail.withdrawn = true
      ;[final] = (await db.update(maintenances).set({ resultDetail: JSON.stringify(detail) }).where(eq(maintenances.id, row.id)).returning()) as [MaintenanceRow]
    }
    await db.insert(auditLogs).values(
      auditRow({ event: 'maintenance.failed', resourceType: 'maintenance', resourceId: row.id, ...(actor ?? {}), metadata: { automatic: actor === null, app_id: row.appId, reason: outcome.reason ?? null, failing: outcome.failing ?? [], release_withdrawn: withdrawn, note: outcome.note ?? null } }),
    )
    if (window) await sendNotice(env, db, final, window, 'failed', detail.release ? {} : { version: null })
    // The note a person wrote, or a compact, language-neutral reason: `health_check: 1/2` is one of two
    // update targets that did not come up healthy.
    const reason = outcome.note || (outcome.reason === 'health_check' ? `health_check: ${(outcome.failing ?? []).length}/${(detail.targets ?? []).length}` : (outcome.reason ?? 'failed'))
    await notifyOwner(env, final, 'custom_apps.maintenance_failed', { reason, failing: (outcome.failing ?? []).length })
  }
  await syncApp(env, row.appId)
  return final
}

/* ── The cron's share ────────────────────────────────────────────────────── */

const appOf = async (db: Database, id: string) => (await db.select().from(apps).where(eq(apps.id, id)).limit(1))[0] ?? null

/**
 * Every five minutes: resends, applies and expires approval requests, reminds, starts and evaluates —
 * each against `now`, so a test drives the calendar by passing a later instant. One maintenance
 * failing is logged and counted, and never stops the others.
 */
const runMaintenances = async (env: Env, now: Date) => {
  const db = getDb(env)
  const totals = { resent: 0, auto_applied: 0, no_response: 0, reminded: 0, started: 0, completed: 0, failed: 0, cancelled: 0, errors: 0 }
  const rows = await db.select().from(maintenances).where(inArray(maintenances.status, ['pending_approval', 'scheduled', 'in_progress']))
  const windows = await windowsOf(db, rows.map((row) => row.id))
  const appCache = new Map<string, AppRow | null>()
  const appFor = async (id: string) => {
    if (!appCache.has(id)) appCache.set(id, await appOf(db, id))
    return appCache.get(id) ?? null
  }

  for (const row of rows) {
    try {
      const app = await appFor(row.appId)
      if (!app) continue
      const offered = windows.get(row.id) ?? []
      const pause = await pauseOf(db, app)

      if (row.status === 'pending_approval') {
        const expired = offered.length === 0 || Math.min(...offered.map((window) => window.startsAt.getTime())) <= now.getTime()
        const due = row.lastSentAt !== null && now.getTime() >= row.lastSentAt.getTime() + hours(MAINTENANCES.resendAfterHours)
        if (pause) {
          if (expired) {
            await cancelMaintenance(env, db, row, { reason: pause, actor: { actorEmail: null } }, now)
            totals.cancelled += 1
          }
          continue
        }
        if (expired || (due && row.sends >= 2)) {
          const result = await autoApply(env, db, row, now, expired ? 'link_expired' : 'no_answer')
          if (result === 'auto_applied') totals.auto_applied += 1
          if (result === 'no_response') totals.no_response += 1
        } else if (due) {
          const sent = await sendRequest(env, db, row, now)
          await db.insert(auditLogs).values(
            auditRow({ event: 'maintenance.resent', resourceType: 'maintenance', resourceId: row.id, metadata: { automatic: true, app_id: row.appId, send: sent.send, recipients: sent.delivered, failed: sent.failed } }),
          )
          totals.resent += 1
        }
        continue
      }

      const window = offered.find((candidate) => candidate.id === row.chosenWindowId)
      if (!window) continue

      if (row.status === 'scheduled') {
        if (pause) {
          if (now >= window.startsAt) {
            await cancelMaintenance(env, db, row, { reason: pause, actor: { actorEmail: null } }, now)
            totals.cancelled += 1
          }
          continue
        }
        if (now >= window.endsAt) {
          // The whole window went by without a run seeing it start (an outage): it did not happen.
          await cancelMaintenance(env, db, row, { reason: 'missed', actor: { actorEmail: null } }, now)
          totals.cancelled += 1
          continue
        }
        if (now >= window.startsAt) {
          if (await start(env, db, row, app, window, now)) totals.started += 1
          continue
        }
        if (!row.reminderSentAt && now.getTime() >= window.startsAt.getTime() - hours(MAINTENANCES.reminderBeforeHours)) {
          if (await remind(env, db, row, app, window, now)) totals.reminded += 1
        }
        continue
      }

      if (row.status === 'in_progress' && now >= evaluationDue(row, window, app)) {
        const health = await healthOf(db, row)
        const finished = await finish(env, db, row, health.ok ? { success: true } : { success: false, reason: 'health_check', failing: health.failing }, null, now)
        if (finished?.status === 'completed') totals.completed += 1
        if (finished?.status === 'failed') totals.failed += 1
      }
    } catch (error) {
      totals.errors += 1
      console.error('maintenance run failed', row.id, error)
    }
  }
  return totals
}

/* ── Overview ────────────────────────────────────────────────────────────── */

/**
 * The overview's counts: requests waiting on the client, maintenances scheduled in the next 7 days,
 * those running now, and those needing a person — no answer, failed in the last 7 days, or sent back
 * by the client (a draft with a rejection).
 */
const overviewCounts = async (db: D1Database, now: Date) => {
  const nowSeconds = seconds(now)
  const week = nowSeconds + 7 * 86_400
  const [row] = (
    await db
      .prepare(
        `SELECT SUM(CASE WHEN m.status = 'pending_approval' THEN 1 ELSE 0 END) AS pending_approval,
                SUM(CASE WHEN m.status = 'scheduled' AND w.starts_at < ? THEN 1 ELSE 0 END) AS upcoming,
                SUM(CASE WHEN m.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
                SUM(CASE WHEN m.status = 'no_response'
                          OR (m.status = 'failed' AND m.finished_at >= ?)
                          OR (m.status = 'draft' AND m.rejected_at IS NOT NULL) THEN 1 ELSE 0 END) AS needs_attention
         FROM maintenances m LEFT JOIN maintenance_windows w ON w.id = m.chosen_window_id`,
      )
      .bind(week, nowSeconds - 7 * 86_400)
      .all<Record<string, number | null>>()
  ).results
  return {
    pending_approval: Number(row?.pending_approval ?? 0),
    upcoming: Number(row?.upcoming ?? 0),
    in_progress: Number(row?.in_progress ?? 0),
    needs_attention: Number(row?.needs_attention ?? 0),
  }
}

export {
  approvalRecipients,
  assertNotPaused,
  cancelMaintenance,
  evaluationDue,
  finish,
  firstEligibleWindow,
  includedInstallations,
  invalidateLinks,
  loadMaintenance,
  MAINTENANCE_LOCALE,
  markScheduled,
  noticeAuthor,
  notifyOwner,
  onReleaseLine,
  overviewCounts,
  pauseOf,
  runMaintenances,
  sendNotice,
  sendRequest,
  serializeMaintenances,
  toWindow,
  viewOf,
  windowLabel,
  windowsOf,
}
export type { LinkRow, MaintenanceRow, MaintenanceView, ResultDetail, WindowRow }
