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
  /** `LOG_LEVELS`: the least severe remote log entry the fleet sends and the server keeps. */
  logLevel: text('log_level').notNull().default('info'),
  /**
   * Whether a screenshot may be asked for at all. Off until the client's contract says so: a
   * screenshot can show the client's own customers, which is personal data (ley 21.719).
   */
  screenshotsEnabled: integer('screenshots_enabled', { mode: 'boolean' }).notNull().default(false),
  /** JSON Schema (the subset in `lib/json-schema.ts`) the remote config document must satisfy. */
  configSchema: text('config_schema'),
  /**
   * The Ed25519 public key (32 bytes, base64) releases are signed against — the same key every build
   * of the app embeds to check what it downloads. The private half lives only in CI. An upload whose
   * signature this key does not verify is refused, so a release in the bucket is always one the
   * devices will accept.
   */
  releasePublicKey: text('release_public_key'),
  /** Seconds a freshly installed version has to report `health_ok` before the device rolls back. */
  updateHealthTimeoutSeconds: integer('update_health_timeout_seconds').notNull().default(600),
  /** Consecutive crashes of a new version after which the device rolls back on its own. */
  updateMaxFailures: integer('update_max_failures').notNull().default(3),
  /** Rollback rate (%) at which a rollout pauses itself. */
  rolloutPauseRollbackPercent: integer('rollout_pause_rollback_percent').notNull().default(20),
  /** Share (%) of updated devices reporting a crash on the new version at which a rollout pauses itself. */
  rolloutPauseCrashPercent: integer('rollout_pause_crash_percent').notNull().default(20),
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
  /** `LOG_LEVELS`, overriding the app's for this device alone — turning one kiosk up to `debug`. */
  logLevelOverride: text('log_level_override'),
  /** Screenshots for this device, on top of the app's switch. Both must be on. */
  screenshotsEnabled: integer('screenshots_enabled', { mode: 'boolean' }).notNull().default(true),
  /** When the current socket opened, while one is open. Null in ping mode or between sockets. */
  socketConnectedAt: integer('socket_connected_at', { mode: 'timestamp' }),
  /**
   * When the last socket closed cleanly. A close the Durable Object saw is known disconnection, so
   * `isConnected` reads it as offline at once instead of waiting out three intervals.
   */
  socketClosedAt: integer('socket_closed_at', { mode: 'timestamp' }),
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

/* ── Remote operation ──────────────────────────────────────────────────────── */

/**
 * A command from the closed catalogue (`COMMAND_TYPES`) for one installation. Delivered in the next
 * heartbeat answer in ping mode, or pushed down the socket the moment it is created in socket mode;
 * acknowledged by the device with its result. Never deleted: it is the record of what was done to a
 * client's device, and when.
 */
const commands = sqliteTable('commands', {
  id: text('id').primaryKey(),
  installationId: text('installation_id').notNull().references(() => installations.id, { onDelete: 'cascade' }),
  appId: text('app_id').notNull(),
  /** `COMMAND_TYPES`. */
  type: text('type').notNull(),
  /** JSON object, or null. */
  payload: text('payload'),
  /** `COMMAND_STATUSES`. */
  status: text('status').notNull().default('pending'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  deliveredAt: integer('delivered_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  /** What the device reported: JSON. */
  result: text('result'),
  createdBy: text('created_by'),
  cancelledBy: text('cancelled_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  index('commands_installation_created_idx').on(table.installationId, table.createdAt),
  index('commands_status_expiry_idx').on(table.status, table.expiresAt),
])

/**
 * A screenshot a device uploaded in answer to a `screenshot` command. The bytes live in R2
 * (`SCREENSHOTS`), with no public access: the panel streams them through this Worker. Kept without
 * expiry by decision, and deletable one by one — a client asking for an image of their customers to
 * be removed is a request that has to be answerable.
 */
const screenshots = sqliteTable('screenshots', {
  id: text('id').primaryKey(),
  installationId: text('installation_id').notNull().references(() => installations.id, { onDelete: 'cascade' }),
  appId: text('app_id').notNull(),
  commandId: text('command_id'),
  objectKey: text('object_key').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [index('screenshots_installation_created_idx').on(table.installationId, table.createdAt)])

/**
 * A feature flag: a boolean, a variant name or a number, aimed at the whole app, one channel or one
 * installation. Several rows can share a key at different scopes; the most specific one that applies
 * to a device wins (`resolveFlags`). `scope_value` is `''` for the app scope rather than null, so the
 * unique index can see the duplicate — SQLite treats every null as distinct.
 */
const flags = sqliteTable('flags', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  description: text('description'),
  /** `TARGET_SCOPES`. */
  scope: text('scope').notNull().default('app'),
  /** The channel or the installation id; `''` for the app scope. */
  scopeValue: text('scope_value').notNull().default(''),
  /** JSON: `true`, `"variant-b"`, `3`. */
  value: text('value').notNull(),
  ...authorship,
  ...timestamps,
}, (table) => [uniqueIndex('flags_app_key_scope_unique').on(table.appId, table.key, table.scope, table.scopeValue)])

/**
 * The remote config document of an app, versioned: every save is a new row, and the current
 * document is the highest version. Restoring an old one saves it again as the next version, so the
 * history only ever grows and always says what each device could have read.
 */
const configVersions = sqliteTable('config_versions', {
  appId: text('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  /** JSON object. */
  document: text('document').notNull(),
  note: text('note'),
  createdBy: text('created_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [primaryKey({ columns: [table.appId, table.version] })])

/** An in-app message: a banner or a modal, shown between `starts_at` and `ends_at` to its target. */
const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  /** `MESSAGE_SEVERITIES`. */
  severity: text('severity').notNull().default('info'),
  /** `MESSAGE_DISPLAYS`. */
  display: text('display').notNull().default('banner'),
  /** `TARGET_SCOPES`, as for flags. */
  scope: text('scope').notNull().default('app'),
  scopeValue: text('scope_value').notNull().default(''),
  startsAt: integer('starts_at', { mode: 'timestamp' }).notNull(),
  /** Null for a message that stays until it is ended or deleted. */
  endsAt: integer('ends_at', { mode: 'timestamp' }),
  ...authorship,
  ...timestamps,
}, (table) => [index('messages_app_starts_idx').on(table.appId, table.startsAt)])

/** That an installation showed a message. The device confirms; the panel counts. */
const messageReceipts = sqliteTable('message_receipts', {
  messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  installationId: text('installation_id').notNull(),
  seenAt: integer('seen_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [primaryKey({ columns: [table.messageId, table.installationId] })])

/* ── Releases ──────────────────────────────────────────────────────────────── */

/**
 * A credential CI uploads releases of one app with. Opaque and stored as a hash, like a device token;
 * shown once when it is created. It can upload and nothing else — no panel route accepts it.
 */
const ciTokens = sqliteTable('ci_tokens', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  label: text('label'),
  tokenHash: text('token_hash').notNull(),
  /** The first characters, so a token can be recognised in a CI settings page without the whole. */
  tokenPrefix: text('token_prefix').notNull(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  revokedBy: text('revoked_by'),
  createdBy: text('created_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex('ci_tokens_hash_unique').on(table.tokenHash),
  index('ci_tokens_app_idx').on(table.appId),
])

/**
 * One build of one version, for one channel, platform and architecture. CI uploads it as a draft;
 * a person publishes it, decides how far it rolls out, and pauses, resumes or withdraws it. The bytes
 * are in R2 (`RELEASES`), never public: a device downloads through a short-lived signed link.
 */
const releases = sqliteTable('releases', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  /** Semantic version, as the device reports it. */
  version: text('version').notNull(),
  /** `CHANNELS`. */
  channel: text('channel').notNull(),
  /** `PLATFORMS`. */
  platform: text('platform').notNull(),
  /** `ARCHES`. */
  arch: text('arch').notNull(),
  /** `RELEASE_STATUSES`. */
  status: text('status').notNull().default('draft'),
  /** Share of eligible installations offered this release, 0–100. */
  rolloutPercent: integer('rollout_percent').notNull().default(0),
  /** JSON array of installation ids offered it regardless of the percentage. */
  rolloutInstallations: text('rollout_installations').notNull().default('[]'),
  /** Devices below this version must update before they carry on: `mandatory` in the offer. */
  minVersion: text('min_version'),
  notes: text('notes'),
  objectKey: text('object_key').notNull(),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  /** SHA-256 of the artifact, hex. Computed by this Worker while the upload streamed in. */
  sha256: text('sha256').notNull(),
  /** Ed25519 signature over the raw SHA-256 digest, base64. Verified against `apps.release_public_key`. */
  signature: text('signature').notNull(),
  /** `ci:<token id>` or the editor's email. */
  uploadedBy: text('uploaded_by'),
  publishedAt: integer('published_at', { mode: 'timestamp' }),
  publishedBy: text('published_by'),
  /** Why it was paused or withdrawn, JSON: `{ by, automatic, reason, … }`. */
  statusReason: text('status_reason'),
  statusChangedAt: integer('status_changed_at', { mode: 'timestamp' }),
  ...timestamps,
}, (table) => [
  uniqueIndex('releases_line_version_unique').on(table.appId, table.channel, table.platform, table.arch, table.version),
  index('releases_app_status_idx').on(table.appId, table.status),
])

/**
 * What a device said about an update: one row per step, so a release's numbers are counted from what
 * devices did rather than from what they were offered. Kept for good — they are the history of a
 * rollout, and there is one per device per step.
 */
const releaseReports = sqliteTable('release_reports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  releaseId: text('release_id').notNull().references(() => releases.id, { onDelete: 'cascade' }),
  appId: text('app_id').notNull(),
  installationId: text('installation_id').notNull(),
  /** `UPDATE_REPORT_STATUSES`. */
  status: text('status').notNull(),
  /** The version the device updated from. */
  fromVersion: text('from_version'),
  /** Free text from the device: why it failed, which check rolled it back. */
  detail: text('detail'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  index('release_reports_release_idx').on(table.releaseId, table.installationId),
  index('release_reports_installation_idx').on(table.installationId, table.createdAt),
  index('release_reports_app_time_idx').on(table.appId, table.createdAt),
])

/* ── Crashes and logs ──────────────────────────────────────────────────────── */

/**
 * Crashes grouped by the signature of their stack and the version that crashed. The group is what
 * the panel lists and what an editor resolves; its counters are kept without expiry, while the
 * individual reports behind it age out with the rest of the raw telemetry. `app_version` is `''`
 * when the device did not say, for the same unique-index reason as `flags.scope_value`.
 */
const crashGroups = sqliteTable('crash_groups', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  /** SHA-256 (hex) of the normalised top frames, or of the message for a report with no stack. */
  signature: text('signature').notNull(),
  appVersion: text('app_version').notNull().default(''),
  /** The first report's exception type and message, as the group's title. */
  title: text('title').notNull(),
  /** `CRASH_STATUSES`. A new report on a `resolved` group reopens it; `ignored` stays ignored. */
  status: text('status').notNull().default('open'),
  occurrences: integer('occurrences').notNull().default(0),
  firstSeenAt: integer('first_seen_at', { mode: 'timestamp' }).notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }).notNull(),
  resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
  resolvedBy: text('resolved_by'),
}, (table) => [
  uniqueIndex('crash_groups_app_signature_version_unique').on(table.appId, table.signature, table.appVersion),
  index('crash_groups_app_seen_idx').on(table.appId, table.lastSeenAt),
])

/** One crash as a device reported it, kept `TELEMETRY.rawRetentionDays`. */
const crashReports = sqliteTable('crash_reports', {
  installationId: text('installation_id').notNull(),
  /** Device-minted, so a report sent twice is stored once. */
  reportId: text('report_id').notNull(),
  appId: text('app_id').notNull(),
  groupId: text('group_id').notNull(),
  appVersion: text('app_version'),
  /** Exception type or signal, e.g. `panic`, `SIGSEGV`, `TypeError`. */
  kind: text('kind'),
  message: text('message'),
  stack: text('stack'),
  /** JSON object. */
  context: text('context'),
  /** Device time, unix milliseconds. */
  occurredAt: integer('occurred_at').notNull(),
  receivedAt: integer('received_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.installationId, table.reportId] }),
  index('crash_reports_group_time_idx').on(table.groupId, table.occurredAt),
  index('crash_reports_app_time_idx').on(table.appId, table.occurredAt),
  index('crash_reports_occurred_idx').on(table.occurredAt),
])

/** Remote log entries at or above the effective level, kept `TELEMETRY.rawRetentionDays`. */
const logEntries = sqliteTable('log_entries', {
  installationId: text('installation_id').notNull(),
  /** Device-minted and unique per installation, like a usage event's. */
  entryId: text('entry_id').notNull(),
  appId: text('app_id').notNull(),
  /** `LOG_LEVELS`. */
  level: text('level').notNull(),
  /** The level's index in `LOG_LEVELS`, so "at least warning" is a comparison. */
  severity: integer('severity').notNull(),
  message: text('message').notNull(),
  /** Module or subsystem that logged it. */
  target: text('target'),
  /** JSON object. */
  context: text('context'),
  occurredAt: integer('occurred_at').notNull(),
  receivedAt: integer('received_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.installationId, table.entryId] }),
  index('log_entries_installation_time_idx').on(table.installationId, table.occurredAt),
  index('log_entries_app_time_idx').on(table.appId, table.occurredAt),
  index('log_entries_occurred_idx').on(table.occurredAt),
])

/* ── Alerts ────────────────────────────────────────────────────────────────── */

/**
 * What to watch (`ALERT_KINDS`), on one app or on every app (`app_id` null), and who to tell. The
 * recipient is the account that created the rule — its `sub`, which is what the notifications
 * Worker files a notification under.
 */
const alertRules = sqliteTable('alert_rules', {
  id: text('id').primaryKey(),
  appId: text('app_id').references(() => apps.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** `ALERT_KINDS`. */
  kind: text('kind').notNull(),
  /** Minutes offline, a percentage or a count, depending on `kind`. */
  threshold: real('threshold').notNull(),
  /** The window a rate or a sustained value is measured over. Unused by `installation_offline`. */
  windowMinutes: integer('window_minutes').notNull().default(15),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** Alerts still open and resolve while silenced; only the notifications stop. */
  silencedUntil: integer('silenced_until', { mode: 'timestamp' }),
  notifyUserId: text('notify_user_id'),
  notifyEmail: text('notify_email'),
  ...authorship,
  ...timestamps,
}, (table) => [index('alert_rules_app_idx').on(table.appId)])

/**
 * One firing of a rule for one subject — an installation, or the app itself — kept for good. At most
 * one unresolved alert exists per rule and subject (a partial unique index), so a condition that holds
 * for an hour is one alert with an `occurrences` count, not twelve.
 */
const alerts = sqliteTable('alerts', {
  id: text('id').primaryKey(),
  ruleId: text('rule_id').notNull().references(() => alertRules.id, { onDelete: 'cascade' }),
  appId: text('app_id').notNull(),
  installationId: text('installation_id'),
  /** `installation:<id>` or `app:<id>`: what the alert is about, for the uniqueness above. */
  subject: text('subject').notNull(),
  /** `ALERT_STATUSES`. */
  status: text('status').notNull().default('open'),
  /** The measurement that tripped it, last time it was evaluated. */
  value: real('value'),
  /** JSON with whatever the kind adds (alias, app name…), for the panel and the notification. */
  details: text('details'),
  occurrences: integer('occurrences').notNull().default(1),
  openedAt: integer('opened_at', { mode: 'timestamp' }).notNull(),
  lastTriggeredAt: integer('last_triggered_at', { mode: 'timestamp' }).notNull(),
  acknowledgedAt: integer('acknowledged_at', { mode: 'timestamp' }),
  acknowledgedBy: text('acknowledged_by'),
  resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
  resolvedBy: text('resolved_by'),
  notifiedAt: integer('notified_at', { mode: 'timestamp' }),
}, (table) => [
  uniqueIndex('alerts_rule_subject_unresolved_unique').on(table.ruleId, table.subject).where(sql`status != 'resolved'`),
  index('alerts_status_opened_idx').on(table.status, table.openedAt),
  index('alerts_app_idx').on(table.appId, table.openedAt),
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
  alertRules,
  alerts,
  apps,
  appKeys,
  auditLogs,
  ciTokens,
  commands,
  companies,
  companyContacts,
  configVersions,
  contacts,
  crashGroups,
  crashReports,
  flags,
  heartbeatLog,
  installationDaily,
  installations,
  logEntries,
  messageReceipts,
  messages,
  metricSamples,
  releaseReports,
  releases,
  screenshots,
  usageEvents,
  usageHourly,
}
