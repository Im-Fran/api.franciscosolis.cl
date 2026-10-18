import type { apps, appKeys, companies, companyContacts, contacts, installations } from '@/db/schema'
import type { AppModule, AppState, LogLevel } from '@/lib/config'
import { iso, parseJsonArray, parseJsonObject } from '@/lib/json'
import { effectiveState, isConnected } from '@/services/presence'
import type { Snapshot } from '@/services/telemetry'

/**
 * Rows to response bodies. The only place a column name becomes a JSON key, so the panel's types and
 * the API's stay one mapping apart.
 */

type CompanyRow = typeof companies.$inferSelect
type ContactRow = typeof contacts.$inferSelect
type LinkRow = typeof companyContacts.$inferSelect
type AppRow = typeof apps.$inferSelect
type AppKeyRow = typeof appKeys.$inferSelect
type InstallationRow = typeof installations.$inferSelect

const toCompany = (row: CompanyRow, counts: { apps?: number; contacts?: number } = {}) => ({
  id: row.id,
  legal_name: row.legalName,
  trade_name: row.tradeName,
  rut: row.rut,
  business_activity: row.businessActivity,
  address: row.address,
  is_company: row.isCompany,
  notes: row.notes,
  app_count: counts.apps ?? 0,
  contact_count: counts.contacts ?? 0,
  created_at: iso(row.createdAt),
  updated_at: iso(row.updatedAt),
  created_by: row.createdBy,
  updated_by: row.updatedBy,
})

const toCompanyBrief = (row: Pick<CompanyRow, 'id' | 'legalName' | 'tradeName' | 'rut'>) => ({
  id: row.id,
  legal_name: row.legalName,
  trade_name: row.tradeName,
  rut: row.rut,
})

const toContact = (row: ContactRow, counts: { companies?: number } = {}) => ({
  id: row.id,
  name: row.name,
  emails: parseJsonArray<string>(row.emails),
  phones: parseJsonArray<string>(row.phones),
  address: row.address,
  notes: row.notes,
  company_count: counts.companies ?? 0,
  created_at: iso(row.createdAt),
  updated_at: iso(row.updatedAt),
  created_by: row.createdBy,
  updated_by: row.updatedBy,
})

const toLink = (row: LinkRow) => ({
  company_id: row.companyId,
  contact_id: row.contactId,
  roles: parseJsonArray<string>(row.roles),
  is_primary: row.isPrimary,
  created_at: iso(row.createdAt),
})

type AppCounts = { installations?: number; connected?: number; needsReview?: number }

const toAppSummary = (row: AppRow, counts: AppCounts = {}) => ({
  id: row.id,
  company_id: row.companyId,
  name: row.name,
  kind: row.kind,
  state: row.state as AppState,
  installation_count: counts.installations ?? 0,
  connected_count: counts.connected ?? 0,
  created_at: iso(row.createdAt),
  updated_at: iso(row.updatedAt),
})

/** The ingest addresses of one app, as a client app is configured with them. */
const ingestUrls = (ingestBaseUrl: string, appId: string) => {
  const base = `${ingestBaseUrl.replace(/\/+$/, '')}/${appId}`
  return { base_url: base, sdk_url: `${base}/sdk.js`, openapi_url: `${base}/openapi.json` }
}

const toApp = (
  row: AppRow,
  company: Pick<CompanyRow, 'id' | 'legalName' | 'tradeName'> | null,
  counts: AppCounts,
  ingestBaseUrl: string,
) => ({
  ...toAppSummary(row, counts),
  description: row.description,
  domain: row.domain,
  repository_url: row.repositoryUrl,
  presence_mode: row.presenceMode,
  heartbeat_interval_seconds: row.heartbeatIntervalSeconds,
  operating_hours: parseJsonObject(row.operatingHours),
  modules: parseJsonArray<AppModule>(row.modules),
  log_level: row.logLevel,
  screenshots_enabled: row.screenshotsEnabled,
  release_public_key: row.releasePublicKey,
  /** Who hears about this app's support tickets. */
  support_assignee_email: row.supportAssigneeEmail,
  update_health_timeout_seconds: row.updateHealthTimeoutSeconds,
  update_max_failures: row.updateMaxFailures,
  rollout_pause_rollback_percent: row.rolloutPauseRollbackPercent,
  rollout_pause_crash_percent: row.rolloutPauseCrashPercent,
  state_message: row.stateMessage,
  state_until: iso(row.stateUntil),
  needs_review_count: counts.needsReview ?? 0,
  company: company ? { id: company.id, legal_name: company.legalName, trade_name: company.tradeName } : null,
  ingest: ingestUrls(ingestBaseUrl, row.id),
  created_by: row.createdBy,
  updated_by: row.updatedBy,
})

const toAppKey = (row: AppKeyRow) => ({
  id: row.id,
  app_id: row.appId,
  key: row.key,
  label: row.label,
  status: row.status,
  created_at: iso(row.createdAt),
  revoked_at: iso(row.revokedAt),
  last_used_at: iso(row.lastUsedAt),
  replaced_by: row.replacedBy,
})

const toInstallationSummary = (row: InstallationRow, intervalSeconds: number, now: Date = new Date()) => ({
  id: row.id,
  app_id: row.appId,
  alias: row.alias,
  device_id: row.deviceId,
  platform: row.platform,
  os_name: row.osName,
  os_version: row.osVersion,
  arch: row.arch,
  hostname: row.hostname,
  app_version: row.appVersion,
  channel: row.channel,
  status: row.status,
  connected: row.status === 'active' && isConnected(row.lastSeenAt, intervalSeconds, now, row.socketClosedAt),
  needs_review: row.needsReview,
  /** Whether a socket is open right now (socket mode). */
  socket_connected: row.socketConnectedAt !== null,
  last_seen_at: iso(row.lastSeenAt),
  enrolled_at: iso(row.enrolledAt),
})

const toInstallation = (
  row: InstallationRow,
  app: Pick<AppRow, 'state' | 'heartbeatIntervalSeconds' | 'logLevel' | 'screenshotsEnabled' | 'presenceMode'>,
  now: Date = new Date(),
) => ({
  ...toInstallationSummary(row, app.heartbeatIntervalSeconds, now),
  previous_app_version: row.previousAppVersion,
  user_agent: row.userAgent,
  last_ip: row.lastIp,
  enrolled_ip: row.enrolledIp,
  last_snapshot: parseJsonObject<Snapshot>(row.lastSnapshot),
  state_override: row.stateOverride as AppState | null,
  state_message: row.stateMessage,
  effective_state: effectiveState(app.state, row.stateOverride),
  log_level_override: row.logLevelOverride as LogLevel | null,
  effective_log_level: (row.logLevelOverride ?? app.logLevel) as LogLevel,
  screenshots_enabled: row.screenshotsEnabled,
  /** Both switches: the app's and this device's. What decides whether a screenshot can be asked for. */
  screenshots_allowed: app.screenshotsEnabled && row.screenshotsEnabled,
  presence_mode: app.presenceMode,
  socket_connected_at: iso(row.socketConnectedAt),
  socket_closed_at: iso(row.socketClosedAt),
  reviewed_at: iso(row.reviewedAt),
  reviewed_by: row.reviewedBy,
  revoked_at: iso(row.revokedAt),
  revoked_by: row.revokedBy,
  access_token_expires_at: iso(row.accessTokenExpiresAt),
  refresh_token_expires_at: iso(row.refreshTokenExpiresAt),
  heartbeat_interval_seconds: app.heartbeatIntervalSeconds,
})

export {
  ingestUrls,
  toApp,
  toAppKey,
  toAppSummary,
  toCompany,
  toCompanyBrief,
  toContact,
  toInstallation,
  toInstallationSummary,
  toLink,
}
export type { AppKeyRow, AppRow, CompanyRow, ContactRow, InstallationRow, LinkRow }
