import { and, desc, eq } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { configVersions, flags } from '@/db/schema'
import { LOG_LEVELS, type LogLevel } from '@/lib/config'
import { parseJsonObject } from '@/lib/json'
import { hashToken } from '@/lib/tokens'
import type { AppRow, InstallationRow } from '@/services/serialize'
import { appliesTo, specificity, type DeviceTarget } from '@/services/targeting'

/**
 * Feature flags and the remote config document, resolved for one device.
 *
 * What `GET /config` answers and what its ETag is computed over. The heartbeat carries the ETag, so a
 * device learns that something changed without downloading the document every interval, and asks
 * for it only then — with `If-None-Match`, so even that request is a 304 when nothing did.
 */

type FlagRow = typeof flags.$inferSelect
type ConfigVersionRow = typeof configVersions.$inferSelect

/** The JSON a flag holds. Unparseable (a hand-edited row) reads as absent rather than failing the read. */
const flagValue = (row: Pick<FlagRow, 'value'>): unknown => {
  try {
    return JSON.parse(row.value)
  } catch {
    return undefined
  }
}

/** Every flag that applies to a device, the most specific row winning per key. Keys sorted. */
const resolveFlags = (rows: FlagRow[], device: DeviceTarget): Record<string, unknown> => {
  const winners = new Map<string, FlagRow>()
  for (const row of rows) {
    if (!appliesTo(row, device)) continue
    const current = winners.get(row.key)
    if (!current || specificity(row) > specificity(current)) winners.set(row.key, row)
  }
  const resolved: Record<string, unknown> = {}
  for (const key of [...winners.keys()].sort()) {
    const value = flagValue(winners.get(key)!)
    if (value !== undefined) resolved[key] = value
  }
  return resolved
}

/** The current config document of an app: the highest version, or an empty version 0. */
const currentConfig = async (db: Database, appId: string): Promise<{ version: number; document: Record<string, unknown>; row: ConfigVersionRow | null }> => {
  const [row] = await db.select().from(configVersions).where(eq(configVersions.appId, appId)).orderBy(desc(configVersions.version)).limit(1)
  return row ? { version: row.version, document: parseJsonObject(row.document) ?? {}, row } : { version: 0, document: {}, row: null }
}

/** The level an installation logs at: its own override, else the app's. */
const effectiveLogLevel = (app: Pick<AppRow, 'logLevel'>, installation: Pick<InstallationRow, 'logLevelOverride'> | null): LogLevel => {
  const candidate = installation?.logLevelOverride ?? app.logLevel
  return (LOG_LEVELS as readonly string[]).includes(candidate) ? (candidate as LogLevel) : 'info'
}

type ResolvedConfig = {
  flags: Record<string, unknown>
  config: Record<string, unknown>
  config_version: number
}

const resolveConfig = async (db: Database, appId: string, device: DeviceTarget): Promise<ResolvedConfig> => {
  const [rows, config] = await Promise.all([db.select().from(flags).where(eq(flags.appId, appId)), currentConfig(db, appId)])
  return { flags: resolveFlags(rows, device), config: config.document, config_version: config.version }
}

/** A strong ETag over a resolved payload. Deterministic: the same flags and document, the same tag. */
const etagOf = async (payload: unknown) => `"${(await hashToken(JSON.stringify(payload))).slice(0, 32)}"`

/** One flag key across every scope, for the panel. */
const flagsForKey = (db: Database, appId: string, key: string) =>
  db.select().from(flags).where(and(eq(flags.appId, appId), eq(flags.key, key)))

export { currentConfig, effectiveLogLevel, etagOf, flagsForKey, flagValue, resolveConfig, resolveFlags }
export type { ConfigVersionRow, FlagRow, ResolvedConfig }
