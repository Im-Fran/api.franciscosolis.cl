import type { AccessTokenClaims } from '@/lib/jwks'
import type { TelemetryMessage } from '@/services/telemetry'

/**
 * Workers Rate Limiting binding (`ratelimits` in wrangler.jsonc). Declared locally because the
 * shipped type is not exported under a stable name across `workers-types` releases.
 */
type RateLimiter = {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

type Env = {
  DB: D1Database
  /** Only ever asked for the JWKS. See `src/lib/jwks.ts` for why it is a binding and not a fetch. */
  AUTH: Fetcher
  /** Metrics and usage events on their way to D1. This Worker is both producer and consumer. */
  TELEMETRY_QUEUE: Queue<TelemetryMessage>

  /** Enrollments per client IP. */
  ENROLL_IP_LIMITER: RateLimiter
  /** Enrollments per app. */
  ENROLL_APP_LIMITER: RateLimiter
  /** Everything else a device sends, per installation. */
  INGEST_LIMITER: RateLimiter

  AUTH_JWKS_URL: string
  AUTH_ISSUER: string
  /** Comma-separated client application ids (`aud`) whose tokens may use the panel. */
  CUSTOM_APPS_ALLOWED_AUDIENCES: string
  /** Comma-separated email domains allowed into the panel. */
  CUSTOM_APPS_ALLOWED_EMAIL_DOMAINS: string
  /**
   * Public base of the ingest surface, e.g. `https://ingest.franciscosolis.cl/custom-apps/v1`. Its
   * host is what `src/index.ts` dispatches on.
   */
  INGEST_PUBLIC_URL: string
}

/** The editor behind a panel request, set on the context by `requireAdmin`. */
type Admin = {
  id: string
  email: string
  name: string | null
  picture: string | null
  roles: string[]
  permissions: string[]
  claims: AccessTokenClaims
}

/** The device behind an ingest request, set on the context by `requireInstallation`. */
type DeviceContext = {
  installationId: string
  appId: string
}

type Variables = {
  admin: Admin
  device: DeviceContext
}

type AppEnv = {
  Bindings: Env
  Variables: Variables
}

export type { Admin, AppEnv, DeviceContext, Env, RateLimiter, Variables }
