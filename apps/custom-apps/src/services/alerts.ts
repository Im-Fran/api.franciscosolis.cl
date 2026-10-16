import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm'
import { getDb, type Database } from '@/db/client'
import { alertRules, alerts, apps, installations } from '@/db/schema'
import type { Env } from '@/env'
import { ALERTS, HEARTBEAT, LOG_LEVELS, type AlertKind } from '@/lib/config'
import { iso, parseJsonObject } from '@/lib/json'
import { publishNotification } from '@/services/notify'
import { MEMORY_PERCENT } from '@/services/rollup'

/**
 * Alert rules, evaluated by the cron every few minutes.
 *
 * A rule finds its *subjects* — the installations or apps its condition holds for right now — and
 * the evaluation reconciles them with the alerts already open:
 *
 * - a subject with no open alert opens one, and its recipient is notified;
 * - one already open is left open, with its last trigger and value refreshed — no new notification;
 * - one that resolved less than `ALERTS.reopenWithinMinutes` ago is reopened rather than raised again,
 *   so a kiosk flapping on a bad network is one alert with a count, not a notification each time;
 * - an open (or acknowledged) alert whose subject no longer qualifies is resolved, and its recipient
 *   told — but only if they were told it opened.
 *
 * Silencing a rule stops the notifications, never the bookkeeping: the panel still shows what
 * happened while nobody was being told.
 */

type RuleRow = typeof alertRules.$inferSelect
type AlertRow = typeof alerts.$inferSelect

type Finding = {
  subject: string
  appId: string
  installationId: string | null
  value: number
  details: Record<string, string | number | null>
}

const minutesAgo = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000)

/** `AND app_id = ?` when the rule is about one app, and its binding. */
const appFilter = (rule: RuleRow, column: string) =>
  rule.appId ? { sql: ` AND ${column} = ?`, bindings: [rule.appId] } : { sql: '', bindings: [] as string[] }

/** What a person calls an installation: its alias, else its hostname, else its device id. */
const NAME_SQL = "COALESCE(NULLIF(i.alias, ''), NULLIF(i.hostname, ''), i.device_id)"

const detectOffline = async (db: D1Database, rule: RuleRow, now: Date): Promise<Finding[]> => {
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const filter = appFilter(rule, 'i.app_id')
  // Offline since the clean socket close when there was one after the last heartbeat, else since
  // the last heartbeat. Still "connected" by the interval rule is never offline, whatever the
  // threshold says. Websites are left out, and so are apps that are suspended on purpose.
  const { results } = await db
    .prepare(
      `SELECT i.id, i.app_id, a.name AS app_name, ${NAME_SQL} AS name,
              CASE WHEN i.socket_closed_at IS NOT NULL AND i.socket_closed_at >= i.last_seen_at THEN i.socket_closed_at ELSE i.last_seen_at END AS offline_since
       FROM installations i JOIN apps a ON a.id = i.app_id
       WHERE i.status = 'active' AND i.platform != 'web' AND a.state != 'suspended' AND i.last_seen_at IS NOT NULL${filter.sql}
         AND NOT (i.last_seen_at >= ? - a.heartbeat_interval_seconds * ${HEARTBEAT.offlineAfterIntervals} AND NOT (i.socket_closed_at IS NOT NULL AND i.socket_closed_at >= i.last_seen_at))
         AND (CASE WHEN i.socket_closed_at IS NOT NULL AND i.socket_closed_at >= i.last_seen_at THEN i.socket_closed_at ELSE i.last_seen_at END) <= ?`,
    )
    .bind(...filter.bindings, nowSeconds, nowSeconds - Math.round(rule.threshold * 60))
    .all<{ id: string; app_id: string; app_name: string; name: string; offline_since: number }>()
  return results.map((row) => ({
    subject: `installation:${row.id}`,
    appId: row.app_id,
    installationId: row.id,
    value: Math.floor((nowSeconds - row.offline_since) / 60),
    details: { app_name: row.app_name, installation_name: row.name, offline_since: new Date(row.offline_since * 1000).toISOString() },
  }))
}

const detectSustained = async (db: D1Database, rule: RuleRow, now: Date, expression: string): Promise<Finding[]> => {
  const filter = appFilter(rule, 's.app_id')
  // Every sample of the window at or above the threshold, and at least two of them: one hot reading
  // is a spike, the rule is about a machine that stays hot.
  const { results } = await db
    .prepare(
      `SELECT s.installation_id, s.app_id, a.name AS app_name, ${NAME_SQL} AS name, AVG(s.value) AS average
       FROM (SELECT installation_id, app_id, ${expression} AS value FROM metric_samples WHERE recorded_at >= ?) s
       JOIN installations i ON i.id = s.installation_id JOIN apps a ON a.id = s.app_id
       WHERE s.value IS NOT NULL AND i.status = 'active'${filter.sql}
       GROUP BY s.installation_id, s.app_id
       HAVING COUNT(*) >= 2 AND MIN(s.value) >= ?`,
    )
    .bind(minutesAgo(now, rule.windowMinutes).getTime(), ...filter.bindings, rule.threshold)
    .all<{ installation_id: string; app_id: string; app_name: string; name: string; average: number }>()
  return results.map((row) => ({
    subject: `installation:${row.installation_id}`,
    appId: row.app_id,
    installationId: row.installation_id,
    value: Math.round(row.average * 10) / 10,
    details: { app_name: row.app_name, installation_name: row.name },
  }))
}

/** Rows of `table` per app in the window, for the rate rules. `since` is in the column's own unit. */
const detectCount = async (db: D1Database, rule: RuleRow, table: string, timeColumn: string, since: number, extra = ''): Promise<Finding[]> => {
  const filter = appFilter(rule, 't.app_id')
  const { results } = await db
    .prepare(
      `SELECT t.app_id, a.name AS app_name, COUNT(*) AS total
       FROM ${table} t JOIN apps a ON a.id = t.app_id
       WHERE t.${timeColumn} >= ?${extra}${filter.sql}
       GROUP BY t.app_id
       HAVING COUNT(*) >= ?`,
    )
    .bind(since, ...filter.bindings, rule.threshold)
    .all<{ app_id: string; app_name: string; total: number }>()
  return results.map((row) => ({
    subject: `app:${row.app_id}`,
    appId: row.app_id,
    installationId: null,
    value: Number(row.total),
    details: { app_name: row.app_name },
  }))
}

/** The subjects a rule's condition holds for at `now`. */
const detect = (db: D1Database, rule: RuleRow, now: Date): Promise<Finding[]> => {
  const windowStart = minutesAgo(now, rule.windowMinutes)
  switch (rule.kind as AlertKind) {
    case 'installation_offline':
      return detectOffline(db, rule, now)
    case 'cpu_high':
      return detectSustained(db, rule, now, 'cpu_percent')
    case 'memory_high':
      return detectSustained(db, rule, now, MEMORY_PERCENT)
    case 'crash_spike':
      return detectCount(db, rule, 'crash_reports', 'occurred_at', windowStart.getTime())
    case 'error_log_spike':
      return detectCount(db, rule, 'log_entries', 'occurred_at', windowStart.getTime(), ` AND t.severity >= ${LOG_LEVELS.indexOf('error')}`)
    case 'enrollment_spike':
      return detectCount(db, rule, 'installations', 'enrolled_at', Math.floor(windowStart.getTime() / 1000))
    default:
      return Promise.resolve([])
  }
}

/** The measurement as a person reads it, unit included. Language-neutral, so it travels in `data`. */
const formatValue = (kind: string, value: number | null) => {
  if (value === null) return null
  if (kind === 'installation_offline') return `${value} min`
  if (kind === 'cpu_high' || kind === 'memory_high') return `${value} %`
  return String(value)
}

const subjectName = (alert: Pick<AlertRow, 'details'>) => {
  const details = parseJsonObject<Record<string, unknown>>(alert.details) ?? {}
  return String(details.installation_name ?? details.app_name ?? '')
}

const notifyRecipient = async (env: Env, rule: RuleRow, alert: AlertRow, type: 'custom_apps.alert_opened' | 'custom_apps.alert_resolved', now: Date) => {
  if (!rule.notifyUserId || (rule.silencedUntil && rule.silencedUntil > now)) return false
  const details = parseJsonObject<Record<string, unknown>>(alert.details) ?? {}
  return publishNotification(env, {
    type,
    user: { id: rule.notifyUserId, email: rule.notifyEmail },
    occurredAt: now,
    url: `/custom-apps/alerts/${alert.id}`,
    data: {
      alert_id: alert.id,
      rule_name: rule.name,
      kind: rule.kind,
      app_name: String(details.app_name ?? ''),
      subject: subjectName(alert),
      value: formatValue(rule.kind, alert.value),
      threshold: formatValue(rule.kind, rule.threshold),
    },
  })
}

/** Reconciles one rule's findings with its unresolved alerts. Answers what changed. */
const reconcile = async (env: Env, db: Database, rule: RuleRow, findings: Finding[], now: Date) => {
  const counts = { opened: 0, reopened: 0, resolved: 0 }
  const [unresolved, recentlyResolved] = await Promise.all([
    db.select().from(alerts).where(and(eq(alerts.ruleId, rule.id), ne(alerts.status, 'resolved'))),
    db
      .select()
      .from(alerts)
      .where(and(eq(alerts.ruleId, rule.id), eq(alerts.status, 'resolved'), gte(alerts.resolvedAt, minutesAgo(now, ALERTS.reopenWithinMinutes)))),
  ])
  const bySubject = new Map(unresolved.map((alert) => [alert.subject, alert]))
  const resolvedBySubject = new Map<string, AlertRow>()
  for (const alert of recentlyResolved) {
    const current = resolvedBySubject.get(alert.subject)
    if (!current || (alert.resolvedAt ?? now) > (current.resolvedAt ?? now)) resolvedBySubject.set(alert.subject, alert)
  }
  const seen = new Set<string>()

  for (const finding of findings) {
    seen.add(finding.subject)
    const details = JSON.stringify(finding.details)
    const open = bySubject.get(finding.subject)
    if (open) {
      await db.update(alerts).set({ lastTriggeredAt: now, value: finding.value, details }).where(eq(alerts.id, open.id))
      continue
    }
    const previous = resolvedBySubject.get(finding.subject)
    if (previous) {
      await db
        .update(alerts)
        .set({ status: 'open', resolvedAt: null, resolvedBy: null, acknowledgedAt: null, acknowledgedBy: null, occurrences: previous.occurrences + 1, lastTriggeredAt: now, value: finding.value, details })
        .where(eq(alerts.id, previous.id))
      counts.reopened += 1
      continue
    }
    const [created] = await db
      .insert(alerts)
      .values({
        id: crypto.randomUUID(),
        ruleId: rule.id,
        appId: finding.appId,
        installationId: finding.installationId,
        subject: finding.subject,
        status: 'open',
        value: finding.value,
        details,
        openedAt: now,
        lastTriggeredAt: now,
      })
      .onConflictDoNothing()
      .returning()
    if (!created) continue
    counts.opened += 1
    if (await notifyRecipient(env, rule, created, 'custom_apps.alert_opened', now)) {
      await db.update(alerts).set({ notifiedAt: now }).where(eq(alerts.id, created.id))
    }
  }

  for (const alert of unresolved) {
    if (seen.has(alert.subject)) continue
    const [resolved] = await db
      .update(alerts)
      .set({ status: 'resolved', resolvedAt: now, resolvedBy: null })
      .where(and(eq(alerts.id, alert.id), ne(alerts.status, 'resolved')))
      .returning()
    if (!resolved) continue
    counts.resolved += 1
    if (alert.notifiedAt) await notifyRecipient(env, rule, resolved, 'custom_apps.alert_resolved', now)
  }
  return counts
}

/**
 * Evaluates every enabled rule. A rule whose evaluation fails is logged and skipped — one broken
 * rule must not blind the others.
 */
const evaluateAlerts = async (env: Env, now: Date = new Date()) => {
  const db = getDb(env)
  const rules = await db.select().from(alertRules).where(eq(alertRules.enabled, true))
  const totals = { rules: rules.length, opened: 0, reopened: 0, resolved: 0, failed: 0 }
  for (const rule of rules) {
    try {
      const counts = await reconcile(env, db, rule, await detect(env.DB, rule, now), now)
      totals.opened += counts.opened
      totals.reopened += counts.reopened
      totals.resolved += counts.resolved
    } catch (error) {
      totals.failed += 1
      console.error('failed to evaluate an alert rule', rule.id, error)
    }
  }
  return totals
}

/** Alerts as the panel lists them, with their rule's name and kind, and their app's name. */
const alertSelection = {
  alert: alerts,
  ruleName: alertRules.name,
  ruleKind: alertRules.kind,
  threshold: alertRules.threshold,
  appName: apps.name,
  installationAlias: installations.alias,
}

type AlertSelection = { alert: AlertRow; ruleName: string; ruleKind: string; threshold: number; appName: string | null; installationAlias: string | null }

const toAlert = (row: AlertSelection) => ({
  id: row.alert.id,
  rule_id: row.alert.ruleId,
  rule_name: row.ruleName,
  kind: row.ruleKind,
  app_id: row.alert.appId,
  app_name: row.appName,
  installation_id: row.alert.installationId,
  subject: row.alert.subject,
  subject_name: subjectName(row.alert),
  status: row.alert.status,
  value: row.alert.value,
  threshold: row.threshold,
  details: parseJsonObject(row.alert.details),
  occurrences: row.alert.occurrences,
  opened_at: iso(row.alert.openedAt),
  last_triggered_at: iso(row.alert.lastTriggeredAt),
  acknowledged_at: iso(row.alert.acknowledgedAt),
  acknowledged_by: row.alert.acknowledgedBy,
  resolved_at: iso(row.alert.resolvedAt),
  resolved_by: row.alert.resolvedBy,
  notified_at: iso(row.alert.notifiedAt),
})

const toRule = (row: RuleRow, appName: string | null, openAlerts = 0) => ({
  id: row.id,
  app_id: row.appId,
  app_name: appName,
  name: row.name,
  kind: row.kind,
  threshold: row.threshold,
  window_minutes: row.windowMinutes,
  enabled: row.enabled,
  silenced_until: iso(row.silencedUntil),
  notify_email: row.notifyEmail,
  open_alerts: openAlerts,
  created_at: iso(row.createdAt),
  updated_at: iso(row.updatedAt),
  created_by: row.createdBy,
  updated_by: row.updatedBy,
})

/** Open and acknowledged alerts, for the overview. */
const unresolvedCount = async (db: Database) => {
  const [row] = await db.select({ count: sql<number>`COUNT(*)` }).from(alerts).where(inArray(alerts.status, ['open', 'acknowledged']))
  return Number(row?.count ?? 0)
}

export { alertSelection, detect, evaluateAlerts, toAlert, toRule, unresolvedCount }
export type { AlertRow, AlertSelection, Finding, RuleRow }
