/**
 * The vocabularies and limits of the custom-apps service, in one place so `GET /` can advertise
 * them and the panel builds its selects from the service rather than from a copy that drifts.
 */

/** Seconds the JWKS is cached per isolate. Same value as every other consumer of the key set. */
const JWKS_CACHE_TTL = 3600

/**
 * The permission the panel requires on top of the email domain. It is the roster: the panel is
 * meant for one person, and "anyone with a company address" is not one person.
 */
const ADMIN_PERMISSION = 'custom-apps:admin'

/** What an app is. Decides nothing on the server yet; it is how the panel groups and labels them. */
const APP_KINDS = ['web', 'desktop', 'android', 'kiosk'] as const
type AppKind = (typeof APP_KINDS)[number]

/** What an installation runs on. iOS is out of scope by decision, so it is not in the list. */
const PLATFORMS = ['windows', 'macos', 'linux', 'android', 'web'] as const
type Platform = (typeof PLATFORMS)[number]

/**
 * The lifecycle of an app, which every installation is told on each heartbeat and obeys.
 *
 * - `active`: working normally.
 * - `grace`: the contract ended; the app keeps working and shows a countdown to `state_until`.
 * - `maintenance`: a notice with the estimated end at `state_until`.
 * - `suspended`: the app shows `state_message` and stops.
 *
 * Set per app, and overridable per installation (`state_override`), which is how one kiosk is put
 * into maintenance while the rest of the fleet keeps selling.
 */
const APP_STATES = ['active', 'grace', 'maintenance', 'suspended'] as const
type AppState = (typeof APP_STATES)[number]

/**
 * Release channels an installation follows: which releases it is offered, and what flags and
 * messages aimed at a channel reach it.
 */
const CHANNELS = ['stable', 'beta'] as const
type Channel = (typeof CHANNELS)[number]

/**
 * How an installation reports that it is alive.
 *
 * - `ping`: `POST /heartbeat` every N seconds. What websites and ordinary desktop apps use.
 * - `socket`: a WebSocket to `GET /socket`, held open by a Durable Object per installation. The
 *   device sends its heartbeats down the socket instead, and everything the panel sends — commands,
 *   a state change, new config or messages — arrives the moment it is made rather than on the next
 *   heartbeat. For kiosks and POS terminals.
 *
 * Either way "connected" is the same rule (`isConnected`), so switching an app between them changes
 * how fast it hears from the panel, never what the panel shows about it.
 */
const PRESENCE_MODES = ['ping', 'socket'] as const
type PresenceMode = (typeof PRESENCE_MODES)[number]

/**
 * Optional ingest modules an app can turn on. Presence (enroll, heartbeat, status) is always on —
 * an app that does not report it is not being maintained. A disabled module's endpoints answer 403
 * and are left out of that app's `openapi.json` and `sdk.js`.
 *
 * - `metrics` / `events`: system metrics and usage analytics.
 * - `logs` / `crashes`: remote logs by level, and crash reports grouped by stack signature.
 * - `config`: feature flags and the remote config document, read from `GET /config`.
 * - `messages`: in-app banners and modals.
 * - `commands`: remote commands from the closed catalogue in `COMMAND_TYPES`, screenshots included.
 * - `updates`: remote updates — the release a device is offered, its signed download, and the
 *   reports that tell a rollout whether it is working.
 */
const APP_MODULES = ['metrics', 'events', 'logs', 'crashes', 'config', 'messages', 'commands', 'updates'] as const
type AppModule = (typeof APP_MODULES)[number]

/** What a contact is to a company. A contact may hold several at once. */
const CONTACT_ROLES = ['owner', 'technical', 'billing', 'maintenance_approver'] as const
type ContactRole = (typeof CONTACT_ROLES)[number]

const INSTALLATION_STATUSES = ['active', 'revoked'] as const
type InstallationStatus = (typeof INSTALLATION_STATUSES)[number]

const KEY_STATUSES = ['active', 'revoked'] as const
type KeyStatus = (typeof KEY_STATUSES)[number]

/** Usage event types a client app may send. `custom` is the escape hatch, named by `name`. */
const EVENT_TYPES = ['session_start', 'session_end', 'screen', 'action', 'custom'] as const
type EventType = (typeof EVENT_TYPES)[number]

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
type Weekday = (typeof WEEKDAYS)[number]

/**
 * Remote log levels, least severe first. An app sets the minimum it wants (`apps.log_level`), an
 * installation can lower or raise it for itself, and the device is told the effective one on every
 * heartbeat. Entries below it are dropped by the server too, so a device that ignores the setting
 * cannot fill the table.
 */
const LOG_LEVELS = ['debug', 'info', 'warning', 'error', 'fatal'] as const
type LogLevel = (typeof LOG_LEVELS)[number]

/**
 * The closed catalogue of remote commands. Closed on purpose: the panel never runs arbitrary shell
 * on a client's device, so anything not in this list cannot be sent, whatever the payload says.
 */
const COMMAND_TYPES = [
  'restart_app',
  'restart_device',
  'reload_config',
  'clear_cache',
  'screenshot',
  'upload_logs',
  'check_update',
] as const
type CommandType = (typeof COMMAND_TYPES)[number]

/**
 * A command's lifecycle: `pending` until a device is told about it, `delivered` once it was, then
 * `succeeded` or `failed` as the device reports. `expired` when nobody acted on it in time,
 * `cancelled` when the panel withdrew it first.
 */
const COMMAND_STATUSES = ['pending', 'delivered', 'succeeded', 'failed', 'expired', 'cancelled'] as const
type CommandStatus = (typeof COMMAND_STATUSES)[number]

const COMMANDS = {
  /** Default and maximum lifetime of a command, in seconds. */
  defaultTtlSeconds: 3600,
  maxTtlSeconds: 7 * 24 * 3600,
  /** Most commands handed to a device in one heartbeat answer. */
  maxPerDelivery: 20,
  /** Largest `payload` or `result`, serialised. */
  maxPayloadBytes: 4096,
} as const

/** Screenshots: what a device may upload, and how big. Kept without expiry, by decision. */
const SCREENSHOTS = {
  maxBytes: 5 * 1024 * 1024,
  contentTypes: ['image/png', 'image/jpeg', 'image/webp'] as const,
} as const

/** What a flag or a message is aimed at. The most specific match wins: installation, channel, app. */
const TARGET_SCOPES = ['app', 'channel', 'installation'] as const
type TargetScope = (typeof TARGET_SCOPES)[number]

const MESSAGE_SEVERITIES = ['info', 'warning', 'critical'] as const
type MessageSeverity = (typeof MESSAGE_SEVERITIES)[number]

/** How a message is shown: a dismissible banner, or a modal the user has to acknowledge. */
const MESSAGE_DISPLAYS = ['banner', 'modal'] as const
type MessageDisplay = (typeof MESSAGE_DISPLAYS)[number]

/** Remote config: the document and its schema, both JSON, both bounded. */
const REMOTE_CONFIG = {
  maxDocumentBytes: 64 * 1024,
  maxSchemaBytes: 32 * 1024,
  /** Flags per app. */
  maxFlags: 200,
  maxFlagValueBytes: 1024,
} as const

/** Crash grouping and the shape of a report. */
const CRASHES = {
  /** Frames of the stack that make up the signature, after normalisation. */
  signatureFrames: 12,
  maxStackBytes: 64 * 1024,
  maxMessageBytes: 2048,
  maxContextBytes: 8192,
  /** Crash reports per request. */
  maxBatch: 20,
} as const

const CRASH_STATUSES = ['open', 'resolved', 'ignored'] as const
type CrashStatus = (typeof CRASH_STATUSES)[number]

const LOGS = {
  maxMessageBytes: 4096,
  maxContextBytes: 4096,
} as const

/**
 * What an alert rule can watch. Each is evaluated every few minutes by the cron, against data this
 * Worker already holds:
 *
 * - `installation_offline`: an installation not seen for `threshold` minutes. Websites are left out —
 *   a browser closing its tab is not an outage.
 * - `cpu_high` / `memory_high`: every sample of the last `window_minutes` at or above `threshold` %.
 * - `crash_spike`: at least `threshold` crash reports in the last `window_minutes`.
 * - `error_log_spike`: at least `threshold` `error`/`fatal` log entries in the last `window_minutes`.
 * - `enrollment_spike`: at least `threshold` new installations in the last `window_minutes` — the
 *   alarm on auto-approved enrollment.
 *
 * - `release_rollbacks`: at least `threshold` rollbacks of an update reported in the last
 *   `window_minutes`, across the app's releases.
 *
 * Site uptime, certificates, contracts and hours arrive with the phases that bring the data they
 * would watch.
 */
const ALERT_KINDS = ['installation_offline', 'cpu_high', 'memory_high', 'crash_spike', 'error_log_spike', 'enrollment_spike', 'release_rollbacks'] as const
type AlertKind = (typeof ALERT_KINDS)[number]

/** `open` until somebody acknowledges it or its condition clears; `resolved` either way at the end. */
const ALERT_STATUSES = ['open', 'acknowledged', 'resolved'] as const
type AlertStatus = (typeof ALERT_STATUSES)[number]

const ALERTS = {
  /**
   * An alert whose condition comes back within this many minutes of resolving is reopened rather
   * than raised again, so a flapping kiosk is one alert with a count, not a notification each time.
   */
  reopenWithinMinutes: 30,
  /** Most alert rules in total. Evaluation is a handful of queries per rule every few minutes. */
  maxRules: 100,
} as const

/**
 * A release's lifecycle.
 *
 * - `draft`: uploaded, offered to nobody.
 * - `published`: offered to the devices its rollout reaches.
 * - `paused`: offered to nobody new; devices that installed it keep it. By hand, or automatically
 *   when its rollback or crash rate crosses the app's thresholds.
 * - `withdrawn`: pulled. Devices running it are offered the newest earlier version as a rollback.
 */
const RELEASE_STATUSES = ['draft', 'published', 'paused', 'withdrawn'] as const
type ReleaseStatus = (typeof RELEASE_STATUSES)[number]

/**
 * What a device reports while it updates, in the order it happens. `health_ok` is the only success:
 * an update counts once the new version has started, reached the API and passed its own checks.
 */
const UPDATE_REPORT_STATUSES = ['downloaded', 'installed', 'health_ok', 'rolled_back', 'failed'] as const
type UpdateReportStatus = (typeof UPDATE_REPORT_STATUSES)[number]

/** What an artifact is built for. `any` fits every architecture of its platform (a JAR, an APK bundle). */
const ARCHES = ['x86_64', 'aarch64', 'x86', 'armv7', 'universal', 'any'] as const
type Arch = (typeof ARCHES)[number]

const RELEASES = {
  /**
   * Largest artifact accepted. A Workers limit before it is a policy: the body a Worker may read is
   * capped at 100 MB, and this leaves room for the request around it. The same cap as the
   * marketplace's builds, for the same reason.
   */
  maxArtifactBytes: 96 * 1024 * 1024,
  /** Lifetime of a download link, in seconds. Long enough for a slow kiosk to start, short enough to be worth nothing shared. */
  downloadTtlSeconds: 15 * 60,
  /** Defaults for the per-app update settings. */
  defaultHealthTimeoutSeconds: 600,
  defaultMaxFailures: 3,
  defaultPauseRollbackPercent: 20,
  defaultPauseCrashPercent: 20,
  /** Reports a rate needs before it may pause a rollout: one bad kiosk out of two is not a trend. */
  pauseMinSample: 3,
  /** Notes on a release. */
  maxNotesLength: 10_000,
} as const

/** Grace before suspension is a contract term, capped at a month. */
const GRACE_MAX_DAYS = 31

/** Heartbeat interval bounds, in seconds. */
const HEARTBEAT = {
  min: 15,
  max: 3600,
  default: 60,
  /**
   * An installation is "connected" while its last heartbeat is younger than this many intervals.
   * Three, so one lost request on a flaky network does not flap the panel.
   */
  offlineAfterIntervals: 3,
} as const

/** Device credentials. Opaque random strings; only their SHA-256 is stored. */
const TOKENS = {
  /** Access token lifetime. Short enough that a stolen token ages out, long enough for a kiosk's day. */
  accessTtlSeconds: 24 * 3600,
  /** Refresh token lifetime, renewed on every refresh. A device offline longer simply re-enrolls. */
  refreshTtlSeconds: 180 * 24 * 3600,
} as const

/** Telemetry retention and the shape of what a device may send. */
const TELEMETRY = {
  /** Raw samples and usage events are kept this many days, then only the daily roll-up remains. */
  rawRetentionDays: 30,
  /**
   * Hourly presence buckets are kept a little longer than the raw data, because the usage heatmap
   * reads a full 30-day window and the window's oldest hour must still be there when it is read.
   */
  hourlyRetentionDays: 35,
  /** Most samples or events accepted in one request. */
  maxBatch: 100,
  /** Largest request body the ingest surface reads, in bytes. */
  maxBodyBytes: 256 * 1024,
  /** Largest `properties` object on one usage event, serialised. */
  maxEventPropertiesBytes: 2048,
  /** How far in the future a device clock may be before a sample is refused, in seconds. */
  maxClockSkewSeconds: 300,
  /** Rows deleted per statement by the purge, so one run never holds the database for long. */
  purgeChunk: 5000,
  /** Statement chunks one purge run may issue per table. */
  purgeMaxChunks: 20,
} as const

/** The daily roll-up runs on Santiago's clock, at this hour, over the day that just ended. */
const ROLLUP = {
  timeZone: 'America/Santiago',
  hour: 3,
} as const

/** Points a metrics series is downsampled to, by default and at most. */
const SERIES = {
  defaultPoints: 240,
  maxPoints: 1000,
  defaultRangeSeconds: 24 * 3600,
} as const

const PAGINATION = {
  defaultLimit: 50,
  maxLimit: 200,
} as const

export {
  ADMIN_PERMISSION,
  ALERT_KINDS,
  ALERT_STATUSES,
  ALERTS,
  APP_KINDS,
  ARCHES,
  APP_MODULES,
  APP_STATES,
  CHANNELS,
  COMMAND_STATUSES,
  COMMAND_TYPES,
  COMMANDS,
  CONTACT_ROLES,
  CRASH_STATUSES,
  CRASHES,
  EVENT_TYPES,
  GRACE_MAX_DAYS,
  HEARTBEAT,
  INSTALLATION_STATUSES,
  JWKS_CACHE_TTL,
  KEY_STATUSES,
  LOG_LEVELS,
  LOGS,
  MESSAGE_DISPLAYS,
  MESSAGE_SEVERITIES,
  PAGINATION,
  PLATFORMS,
  PRESENCE_MODES,
  RELEASE_STATUSES,
  RELEASES,
  REMOTE_CONFIG,
  ROLLUP,
  SCREENSHOTS,
  SERIES,
  TARGET_SCOPES,
  TELEMETRY,
  TOKENS,
  UPDATE_REPORT_STATUSES,
  WEEKDAYS,
}
export type {
  AlertKind,
  AlertStatus,
  AppKind,
  AppModule,
  AppState,
  Arch,
  Channel,
  CommandStatus,
  CommandType,
  ContactRole,
  CrashStatus,
  EventType,
  InstallationStatus,
  KeyStatus,
  LogLevel,
  MessageDisplay,
  MessageSeverity,
  Platform,
  PresenceMode,
  ReleaseStatus,
  TargetScope,
  UpdateReportStatus,
  Weekday,
}
