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

/** Release channels an installation follows. Nothing is released yet; the channel is recorded now. */
const CHANNELS = ['stable', 'beta'] as const
type Channel = (typeof CHANNELS)[number]

/**
 * How an installation reports that it is alive.
 *
 * Only `ping` today: `POST /heartbeat` every N seconds. A persistent `socket` mode belongs with
 * remote commands, which are what make a held-open connection worth its cost, and it will be added
 * to this list then — not before, so no app can be configured into a mode nothing answers.
 */
const PRESENCE_MODES = ['ping'] as const
type PresenceMode = (typeof PRESENCE_MODES)[number]

/**
 * Optional ingest modules an app can turn on. Presence (enroll, heartbeat, status) is always on —
 * an app that does not report it is not being maintained. A disabled module's endpoints answer 403
 * and are left out of that app's `openapi.json` and `sdk.js`.
 */
const APP_MODULES = ['metrics', 'events'] as const
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
  APP_KINDS,
  APP_MODULES,
  APP_STATES,
  CHANNELS,
  CONTACT_ROLES,
  EVENT_TYPES,
  HEARTBEAT,
  INSTALLATION_STATUSES,
  JWKS_CACHE_TTL,
  KEY_STATUSES,
  PAGINATION,
  PLATFORMS,
  PRESENCE_MODES,
  ROLLUP,
  SERIES,
  TELEMETRY,
  TOKENS,
  WEEKDAYS,
}
export type {
  AppKind,
  AppModule,
  AppState,
  Channel,
  ContactRole,
  EventType,
  InstallationStatus,
  KeyStatus,
  Platform,
  PresenceMode,
  Weekday,
}
