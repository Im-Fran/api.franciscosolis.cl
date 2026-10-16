import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * D1 schema for `franciscosolis_custom_apps`.
 *
 * Conventions, kept in line with the other stateful Workers:
 * - Primary keys are UUID v4 strings generated in the Worker.
 * - Timestamps are unix seconds (`integer` + `{ mode: 'timestamp' }`) defaulting to `unixepoch()`.
 * - Editors are recorded by email: accounts live in the auth database, which this Worker cannot
 *   reach, and an email is what an audit trail is read by.
 *
 * The axis is company → app → installation, and those three use foreign keys: an app means nothing
 * without its company, and an installation nothing without its app. Deletes are *refused* rather
 * than cascaded along that axis (`ON DELETE RESTRICT`) — removing a company must never silently take
 * its fleet and its telemetry with it. The telemetry tables carry no foreign keys: they are written
 * by the queue consumer in bulk, and a sample for an installation deleted a second earlier is
 * harmless where a constraint failure would fail the whole batch.
 */

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}

const authorship = {
  createdBy: text('created_by'),
  updatedBy: text('updated_by'),
}

/* ── CRM ───────────────────────────────────────────────────────────────────── */

/**
 * A client: a company, or a natural person (`is_company = false`) who hires work in their own name.
 * Chilean tax data, because that is what an invoice needs.
 */
const companies = sqliteTable('companies', {
  id: text('id').primaryKey(),
  /** Razón social, or the person's full name. */
  legalName: text('legal_name').notNull(),
  /** Nombre de fantasía. */
  tradeName: text('trade_name'),
  /** Normalised `12345678-5`, check digit verified on write. Unique when present. */
  rut: text('rut'),
  /** Giro. */
  businessActivity: text('business_activity'),
  address: text('address'),
  isCompany: integer('is_company', { mode: 'boolean' }).notNull().default(true),
  notes: text('notes'),
  ...authorship,
  ...timestamps,
}, (table) => [
  uniqueIndex('companies_rut_unique').on(table.rut),
  index('companies_legal_name_idx').on(table.legalName),
])

/** A person, who may belong to several companies under different roles. */
const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** JSON array of addresses. */
  emails: text('emails').notNull().default('[]'),
  /** JSON array of phone numbers, as typed. */
  phones: text('phones').notNull().default('[]'),
  address: text('address'),
  notes: text('notes'),
  ...authorship,
  ...timestamps,
}, (table) => [index('contacts_name_idx').on(table.name)])

/**
 * What a contact is to a company. Many-to-many, with the roles on the link: the same person can be
 * the technical contact at one client and the owner of another.
 */
const companyContacts = sqliteTable('company_contacts', {
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  contactId: text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  /** JSON array from `CONTACT_ROLES`. */
  roles: text('roles').notNull().default('[]'),
  /** At most one per company; enforced by the route that sets it. */
  isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  primaryKey({ columns: [table.companyId, table.contactId] }),
  index('company_contacts_contact_idx').on(table.contactId),
])

/* ── Apps ──────────────────────────────────────────────────────────────────── */

const apps = sqliteTable('apps', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  description: text('description'),
  /** `APP_KINDS`. */
  kind: text('kind').notNull(),
  /** Hostname a web app is served on. */
  domain: text('domain'),
  repositoryUrl: text('repository_url'),
  /** `PRESENCE_MODES`. */
  presenceMode: text('presence_mode').notNull().default('ping'),
  heartbeatIntervalSeconds: integer('heartbeat_interval_seconds').notNull().default(60),
  /** JSON `{ timezone, days }`, or null when the app has no declared hours. */
  operatingHours: text('operating_hours'),
  /** JSON array from `APP_MODULES`. */
  modules: text('modules').notNull().default('[]'),
  /** `APP_STATES`: the kill switch every installation obeys. */
  state: text('state').notNull().default('active'),
  stateMessage: text('state_message'),
  /** End of a grace period, or a maintenance's estimated end. */
  stateUntil: integer('state_until', { mode: 'timestamp' }),
  ...authorship,
  ...timestamps,
}, (table) => [
  index('apps_company_idx').on(table.companyId),
  index('apps_state_idx').on(table.state),
])

/**
 * The public key a client app enrolls with. Public by design — it ships inside every build and every
 * `sdk.js` — so it is stored as it is and shown in full. What protects the fleet is that enrolling
 * only ever yields a token for *one* revocable installation, and that revoking a key stops new
 * enrollments without touching the devices already enrolled.
 */
const appKeys = sqliteTable('app_keys', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  label: text('label'),
  /** `KEY_STATUSES`. */
  status: text('status').notNull().default('active'),
  /** The key a rotation replaced this one with. */
  replacedBy: text('replaced_by'),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  createdBy: text('created_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex('app_keys_key_unique').on(table.key),
  index('app_keys_app_idx').on(table.appId),
])

/**
 * One device (or one browser, for a website) running an app. The unit of everything the panel
 * monitors, and the unit of revocation: its token is its own.
 */
const installations = sqliteTable('installations', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull().references(() => apps.id, { onDelete: 'restrict' }),
  /** Stable identifier the device reports; unique per app, so a re-enrollment finds its row. */
  deviceId: text('device_id').notNull(),
  /** "Tótem entrada" — set in the panel, or suggested by the device on enrollment. */
  alias: text('alias'),
  /** `PLATFORMS`. */
  platform: text('platform').notNull(),
  osName: text('os_name'),
  osVersion: text('os_version'),
  arch: text('arch'),
  hostname: text('hostname'),
  userAgent: text('user_agent'),
  appVersion: text('app_version'),
  /** The version reported before the current one, kept when a heartbeat reports a new one. */
  previousAppVersion: text('previous_app_version'),
  /** `CHANNELS`. */
  channel: text('channel').notNull().default('stable'),
  /** `INSTALLATION_STATUSES`. A revoked installation can never enroll again under its device id. */
  status: text('status').notNull().default('active'),
  /** Set on every new enrollment: auto-approval admits anybody holding the key, so a person looks. */
  needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(true),
  reviewedAt: integer('reviewed_at', { mode: 'timestamp' }),
  reviewedBy: text('reviewed_by'),
  /** Per-installation kill switch, overriding the app's `state` when set. */
  stateOverride: text('state_override'),
  stateMessage: text('state_message'),
  enrolledWithKeyId: text('enrolled_with_key_id'),
  enrolledIp: text('enrolled_ip'),
  enrolledAt: integer('enrolled_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
  lastIp: text('last_ip'),
  /** JSON of the last heartbeat's snapshot. The live view; the series is in `metric_samples`. */
  lastSnapshot: text('last_snapshot'),
  /** SHA-256 (hex) of the current access token. Never the token itself. */
  accessTokenHash: text('access_token_hash'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
  refreshTokenHash: text('refresh_token_hash'),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  revokedBy: text('revoked_by'),
  ...timestamps,
}, (table) => [
  uniqueIndex('installations_app_device_unique').on(table.appId, table.deviceId),
  uniqueIndex('installations_access_token_unique').on(table.accessTokenHash),
  uniqueIndex('installations_refresh_token_unique').on(table.refreshTokenHash),
  index('installations_app_seen_idx').on(table.appId, table.lastSeenAt),
  index('installations_review_idx').on(table.needsReview, table.status),
])

/* ── Telemetry ─────────────────────────────────────────────────────────────── */

/**
 * Raw system metrics, kept `TELEMETRY.rawRetentionDays`. Every measurement is nullable because every
 * platform measures a different subset: a browser reports none of them, a desktop most, and a value
 * a platform cannot measure must read as "not available", never as zero.
 *
 * Two sources write here, and `source` keeps them apart:
 *
 * - `batch`: what a device sends to `POST /metrics`, at whatever resolution it measures.
 *   `(installation_id, source, recorded_at)` is unique so a redelivered queue batch inserts nothing
 *   twice.
 * - `heartbeat`: the snapshot a heartbeat carries, filed under the **start of its minute**. A second
 *   heartbeat in the same minute overwrites the first instead of adding a row, so the series holds
 *   one point per minute however often a device sends — what it sent is still all in
 *   `heartbeat_log`. Network deltas are the exception: they are *added*, since bytes moved in the
 *   first heartbeat of a minute did not stop counting because a second one arrived.
 */
const metricSamples = sqliteTable('metric_samples', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  installationId: text('installation_id').notNull(),
  appId: text('app_id').notNull(),
  /** `batch` or `heartbeat`; see above. */
  source: text('source').notNull().default('batch'),
  /** Device time of the measurement, unix milliseconds. */
  recordedAt: integer('recorded_at').notNull(),
  receivedAt: integer('received_at', { mode: 'timestamp' }).notNull(),
  cpuPercent: real('cpu_percent'),
  memoryUsedBytes: integer('memory_used_bytes'),
  memoryTotalBytes: integer('memory_total_bytes'),
  gpuPercent: real('gpu_percent'),
  diskUsedBytes: integer('disk_used_bytes'),
  diskTotalBytes: integer('disk_total_bytes'),
  /** Bytes received and sent since the previous sample. */
  netRxBytes: integer('net_rx_bytes'),
  netTxBytes: integer('net_tx_bytes'),
  batteryPercent: real('battery_percent'),
  batteryCharging: integer('battery_charging', { mode: 'boolean' }),
  powerWatts: real('power_watts'),
}, (table) => [
  uniqueIndex('metric_samples_installation_source_time_unique').on(table.installationId, table.source, table.recordedAt),
  index('metric_samples_installation_time_idx').on(table.installationId, table.recordedAt),
  index('metric_samples_recorded_idx').on(table.recordedAt),
])

/**
 * Every heartbeat as it arrived, kept `TELEMETRY.rawRetentionDays`: the audit record of what a device
 * reported and when. `metric_samples` only keeps the last heartbeat of each minute, so this is the
 * one place a device that heartbeats ten times a minute can be seen doing it.
 */
const heartbeatLog = sqliteTable('heartbeat_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  installationId: text('installation_id').notNull(),
  appId: text('app_id').notNull(),
  /** Server time of arrival, unix milliseconds. */
  receivedAt: integer('received_at').notNull(),
  ip: text('ip'),
  appVersion: text('app_version'),
  /** `active_seconds` as the device reported it, before any capping. */
  activeSeconds: integer('active_seconds'),
  /** Seconds this heartbeat credited as online — zero after a gap past the offline threshold. */
  creditedSeconds: integer('credited_seconds').notNull().default(0),
  /** The snapshot exactly as sent (after validation), JSON. */
  snapshot: text('snapshot'),
}, (table) => [
  index('heartbeat_log_installation_time_idx').on(table.installationId, table.receivedAt),
  index('heartbeat_log_received_idx').on(table.receivedAt),
])

/** Usage and analytics events (sessions, screens, actions), kept `TELEMETRY.rawRetentionDays`. */
const usageEvents = sqliteTable('usage_events', {
  installationId: text('installation_id').notNull(),
  /** Device-minted, so a retried batch is recognised. Unique per installation. */
  eventId: text('event_id').notNull(),
  appId: text('app_id').notNull(),
  type: text('type').notNull(),
  name: text('name'),
  sessionId: text('session_id'),
  /** Device time, unix milliseconds. */
  occurredAt: integer('occurred_at').notNull(),
  receivedAt: integer('received_at', { mode: 'timestamp' }).notNull(),
  /** JSON object, capped at `TELEMETRY.maxEventPropertiesBytes`. */
  properties: text('properties'),
}, (table) => [
  primaryKey({ columns: [table.installationId, table.eventId] }),
  index('usage_events_installation_time_idx').on(table.installationId, table.occurredAt),
  index('usage_events_occurred_idx').on(table.occurredAt),
])

/**
 * Presence and use per installation per UTC hour, written by every heartbeat.
 *
 * The unit the usage heatmap is drawn from: hours are what a maintenance window is planned in, and a
 * UTC hour maps onto exactly one Santiago hour (the offset is a whole number of hours either side of
 * daylight saving). Kept `TELEMETRY.hourlyRetentionDays`; the daily roll-up keeps the totals forever.
 */
const usageHourly = sqliteTable('usage_hourly', {
  installationId: text('installation_id').notNull(),
  appId: text('app_id').notNull(),
  /** Start of the UTC hour, unix seconds. */
  hourStart: integer('hour_start').notNull(),
  /** Seconds the installation was connected during the hour. */
  onlineSeconds: integer('online_seconds').notNull().default(0),
  /** Seconds somebody was actually using it, as the device reported. */
  activeSeconds: integer('active_seconds').notNull().default(0),
  heartbeats: integer('heartbeats').notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.installationId, table.hourStart] }),
  index('usage_hourly_app_hour_idx').on(table.appId, table.hourStart),
  index('usage_hourly_hour_idx').on(table.hourStart),
])

/**
 * The daily roll-up per installation, kept without expiry. One row per Santiago day, recomputed
 * from the raw tables (so re-running a day replaces it rather than adding to it).
 */
const installationDaily = sqliteTable('installation_daily', {
  installationId: text('installation_id').notNull(),
  appId: text('app_id').notNull(),
  /** `YYYY-MM-DD` in `ROLLUP.timeZone`. */
  day: text('day').notNull(),
  onlineSeconds: integer('online_seconds').notNull().default(0),
  activeSeconds: integer('active_seconds').notNull().default(0),
  cpuAvg: real('cpu_avg'),
  cpuMax: real('cpu_max'),
  cpuP95: real('cpu_p95'),
  /** Memory as a percentage of the total the device reported. */
  memoryAvg: real('memory_avg'),
  memoryMax: real('memory_max'),
  memoryP95: real('memory_p95'),
  gpuAvg: real('gpu_avg'),
  gpuMax: real('gpu_max'),
  netRxBytes: integer('net_rx_bytes').notNull().default(0),
  netTxBytes: integer('net_tx_bytes').notNull().default(0),
  batteryMin: real('battery_min'),
  samples: integer('samples').notNull().default(0),
  events: integer('events').notNull().default(0),
  computedAt: integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  primaryKey({ columns: [table.installationId, table.day] }),
  index('installation_daily_app_day_idx').on(table.appId, table.day),
])

/* ── Audit ─────────────────────────────────────────────────────────────────── */

/**
 * Append-only. The migration adds triggers that abort any UPDATE or DELETE on this table, so the
 * guarantee does not depend on every future route remembering not to write one.
 */
const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  event: text('event').notNull(),
  /** The editor, or null for something the system or a device did. */
  actorEmail: text('actor_email'),
  actorId: text('actor_id'),
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  /** JSON, carrying `{ before, after }` for an edit. */
  metadata: text('metadata'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  index('audit_logs_created_idx').on(table.createdAt),
  index('audit_logs_resource_idx').on(table.resourceType, table.resourceId),
])

export {
  apps,
  appKeys,
  auditLogs,
  companies,
  companyContacts,
  contacts,
  heartbeatLog,
  installationDaily,
  installations,
  metricSamples,
  usageEvents,
  usageHourly,
}
