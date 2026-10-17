import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { releases } from '@/db/schema'
import { RELEASES, type Arch } from '@/lib/config'
import { iso, parseJsonArray } from '@/lib/json'
import { compareSemver } from '@/lib/semver'
import { hashToken } from '@/lib/tokens'
import { effectiveState } from '@/services/presence'
import type { AppRow, InstallationRow } from '@/services/serialize'

/**
 * Releases: which one a device is offered, and how a rollout is doing.
 *
 * **The offer** is computed, never stored, from three facts: the releases of the device's line
 * (app, channel, platform, architecture), the device's rollout bucket, and the version it runs. The
 * newest published release whose rollout reaches the device is offered when it is newer than what
 * the device runs. A device running a version that was *withdrawn* is offered the newest earlier one
 * instead, flagged `rollback` — that is what "forzar un rollback" means from the panel's side. Nothing
 * is offered while the app is in grace or suspended: during grace only the app itself keeps working.
 */

type ReleaseRow = typeof releases.$inferSelect

/** What devices call their architecture, mapped onto `ARCHES`. */
const ARCH_ALIASES: Record<string, Arch> = {
  x86_64: 'x86_64',
  amd64: 'x86_64',
  x64: 'x86_64',
  aarch64: 'aarch64',
  arm64: 'aarch64',
  x86: 'x86',
  i386: 'x86',
  i686: 'x86',
  armv7: 'armv7',
  armv7l: 'armv7',
  armeabi_v7a: 'armv7',
  'armeabi-v7a': 'armv7',
}

const normaliseArch = (value: string | null | undefined): Arch | null => (value ? (ARCH_ALIASES[value.trim().toLowerCase()] ?? null) : null)

/**
 * The installation's rollout bucket, 0–99: SHA-256 of app and installation. Stable across releases
 * on purpose — the devices that take the first 10 % of one release take the first 10 % of the next,
 * so the canaries are known kiosks rather than a different random handful every time.
 */
const rolloutBucket = async (appId: string, installationId: string) =>
  Number.parseInt((await hashToken(`${appId}:${installationId}`)).slice(0, 8), 16) % 100

const reaches = (release: ReleaseRow, installationId: string, bucket: number) =>
  parseJsonArray<string>(release.rolloutInstallations).includes(installationId) || bucket < release.rolloutPercent

type OfferInput = {
  app: AppRow
  installation: Pick<InstallationRow, 'id' | 'channel' | 'platform' | 'arch' | 'appVersion' | 'stateOverride'>
  /** What the device says about itself, when it knows better than its enrollment did. */
  platform?: string | null
  arch?: string | null
  version?: string | null
}

type Offer = {
  release: ReleaseRow
  mandatory: boolean
  rollback: boolean
}

/** The releases of one line: everything a device on it could be offered or could be running. */
const lineReleases = (db: Database, appId: string, channel: string, platform: string, arch: Arch | null) =>
  db
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.appId, appId),
        eq(releases.channel, channel),
        eq(releases.platform, platform),
        inArray(releases.arch, arch ? [arch, 'universal', 'any'] : ['universal', 'any']),
        inArray(releases.status, ['published', 'paused', 'withdrawn']),
      ),
    )

const newest = (rows: ReleaseRow[]) => rows.reduce<ReleaseRow | null>((best, row) => (!best || compareSemver(row.version, best.version) > 0 ? row : best), null)

/** What a device should install now, if anything. */
const offerFor = async (db: Database, input: OfferInput): Promise<Offer | null> => {
  const { app, installation } = input
  const state = effectiveState(app.state, installation.stateOverride)
  if (state === 'grace' || state === 'suspended') return null

  const platform = input.platform ?? installation.platform
  const arch = normaliseArch(input.arch ?? installation.arch)
  const current = input.version ?? installation.appVersion
  const rows = await lineReleases(db, app.id, installation.channel, platform, arch)
  if (rows.length === 0) return null

  const bucket = await rolloutBucket(app.id, installation.id)
  const best = newest(rows.filter((row) => row.status === 'published' && reaches(row, installation.id, bucket)))
  const below = (minVersion: string | null) => minVersion !== null && compareSemver(current, minVersion) < 0

  if (best && (!current || compareSemver(best.version, current) > 0)) {
    return { release: best, mandatory: below(best.minVersion), rollback: false }
  }

  // Running a withdrawn version: go back to the newest earlier one that is still live, whatever its
  // rollout says — a rollback is not a canary.
  const running = current ? rows.find((row) => compareSemver(row.version, current) === 0) : undefined
  if (running?.status === 'withdrawn') {
    const target = newest(rows.filter((row) => row.status !== 'withdrawn' && compareSemver(row.version, current) < 0))
    if (target) return { release: target, mandatory: true, rollback: true }
  }
  return null
}

/** The offer as a device reads it. */
const toDeviceOffer = (offer: Offer, app: Pick<AppRow, 'updateHealthTimeoutSeconds' | 'updateMaxFailures'>) => ({
  release_id: offer.release.id,
  version: offer.release.version,
  channel: offer.release.channel,
  platform: offer.release.platform,
  arch: offer.release.arch,
  filename: offer.release.filename,
  size_bytes: offer.release.sizeBytes,
  sha256: offer.release.sha256,
  signature: offer.release.signature,
  notes: offer.release.notes,
  min_version: offer.release.minVersion,
  mandatory: offer.mandatory,
  rollback: offer.rollback,
  published_at: iso(offer.release.publishedAt),
  health_check_timeout_seconds: app.updateHealthTimeoutSeconds,
  max_failures: app.updateMaxFailures,
})

/** The short form a heartbeat answer carries: enough to know whether to ask for the rest. */
const toOfferSummary = (offer: Offer | null) =>
  offer ? { release_id: offer.release.id, version: offer.release.version, mandatory: offer.mandatory, rollback: offer.rollback } : null

/* ── Rollout numbers ─────────────────────────────────────────────────────── */

type ReleaseStats = {
  downloaded: number
  installed: number
  health_ok: number
  rolled_back: number
  failed: number
  /** Devices reporting a crash on this version since it was published. */
  crashed: number
  /** rolled_back / (health_ok + rolled_back), or null with nothing to divide. */
  rollback_rate: number | null
  /** crashed / devices that installed it, or null. */
  crash_rate: number | null
}

/**
 * How a release is doing, per device: each count is the number of distinct installations that ever
 * reported that step, so a device that retried a download twice is one download. Both rates are
 * computed over devices that got far enough for the question to apply.
 */
const releaseStats = async (db: D1Database, release: Pick<ReleaseRow, 'id' | 'appId' | 'version' | 'publishedAt'>): Promise<ReleaseStats> => {
  const since = release.publishedAt ? release.publishedAt.getTime() : 0
  const [counts, crashes] = await db.batch<{ status?: string; devices: number }>([
    db.prepare('SELECT status, COUNT(DISTINCT installation_id) AS devices FROM release_reports WHERE release_id = ? GROUP BY status').bind(release.id),
    db
      .prepare(
        `SELECT COUNT(DISTINCT c.installation_id) AS devices FROM crash_reports c
         WHERE c.app_id = ? AND c.app_version = ? AND c.occurred_at >= ?
           AND c.installation_id IN (SELECT installation_id FROM release_reports WHERE release_id = ? AND status IN ('installed', 'health_ok'))`,
      )
      .bind(release.appId, release.version, since, release.id),
  ])
  const by = Object.fromEntries(counts!.results.map((row) => [row.status, Number(row.devices)]))
  const stats = {
    downloaded: by.downloaded ?? 0,
    installed: by.installed ?? 0,
    health_ok: by.health_ok ?? 0,
    rolled_back: by.rolled_back ?? 0,
    failed: by.failed ?? 0,
    crashed: Number(crashes!.results[0]?.devices ?? 0),
  }
  const settled = stats.health_ok + stats.rolled_back
  const updated = Math.max(stats.installed, settled)
  return {
    ...stats,
    rollback_rate: settled > 0 ? Math.round((stats.rolled_back / settled) * 1000) / 10 : null,
    crash_rate: updated > 0 ? Math.round((stats.crashed / updated) * 1000) / 10 : null,
  }
}

/**
 * Whether a rollout should pause itself, and why. A rate needs `RELEASES.pauseMinSample` devices
 * behind it: one kiosk out of two rolling back is a kiosk, not a release.
 */
const pauseReason = (stats: ReleaseStats, app: Pick<AppRow, 'rolloutPauseRollbackPercent' | 'rolloutPauseCrashPercent'>) => {
  const settled = stats.health_ok + stats.rolled_back
  if (settled >= RELEASES.pauseMinSample && stats.rollback_rate !== null && stats.rollback_rate >= app.rolloutPauseRollbackPercent) {
    return { reason: 'rollback_rate', rate: stats.rollback_rate, threshold: app.rolloutPauseRollbackPercent, sample: settled }
  }
  const updated = Math.max(stats.installed, settled)
  if (updated >= RELEASES.pauseMinSample && stats.crash_rate !== null && stats.crash_rate >= app.rolloutPauseCrashPercent) {
    return { reason: 'crash_rate', rate: stats.crash_rate, threshold: app.rolloutPauseCrashPercent, sample: updated }
  }
  return null
}

/* ── Signatures ──────────────────────────────────────────────────────────── */

const decodeBase64 = (value: string): Uint8Array | null => {
  try {
    const normalised = value.trim().replace(/-/g, '+').replace(/_/g, '/')
    return Uint8Array.from(atob(normalised.padEnd(Math.ceil(normalised.length / 4) * 4, '=')), (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

/** A release public key as stored: 32 raw bytes, base64. Null when it is not one. */
const parsePublicKey = (value: string) => {
  const bytes = decodeBase64(value)
  return bytes && bytes.length === 32 ? bytes : null
}

/**
 * Whether `signature` (base64, 64 bytes) is the Ed25519 signature of `digest` — the raw 32-byte
 * SHA-256 of the artifact — under `publicKey`. The digest rather than the bytes, so neither CI nor this
 * Worker ever has to hold a whole build in memory to sign or check it; a device verifies the same way:
 * hash the download, then check the signature over the hash.
 */
const verifyReleaseSignature = async (publicKey: string, digest: Uint8Array, signature: string) => {
  const key = parsePublicKey(publicKey)
  const sig = decodeBase64(signature)
  if (!key || !sig || sig.length !== 64) return false
  try {
    const imported = await crypto.subtle.importKey('raw', key, { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'Ed25519' }, imported, sig, digest)
  } catch {
    return false
  }
}

/* ── Serialisation ───────────────────────────────────────────────────────── */

const toRelease = (row: ReleaseRow, extra: { stats?: ReleaseStats } = {}) => ({
  id: row.id,
  app_id: row.appId,
  version: row.version,
  channel: row.channel,
  platform: row.platform,
  arch: row.arch,
  status: row.status,
  rollout_percent: row.rolloutPercent,
  rollout_installations: parseJsonArray<string>(row.rolloutInstallations),
  min_version: row.minVersion,
  notes: row.notes,
  filename: row.filename,
  content_type: row.contentType,
  size_bytes: row.sizeBytes,
  sha256: row.sha256,
  signature: row.signature,
  uploaded_by: row.uploadedBy,
  published_at: iso(row.publishedAt),
  published_by: row.publishedBy,
  status_reason: row.statusReason ? (JSON.parse(row.statusReason) as Record<string, unknown>) : null,
  status_changed_at: iso(row.statusChangedAt),
  created_at: iso(row.createdAt),
  updated_at: iso(row.updatedAt),
  ...(extra.stats ? { stats: extra.stats } : {}),
})

/** Devices that ever reported a step, as subqueries for a list of releases. */
const reportCountSql = (status: string) =>
  sql<number>`(SELECT COUNT(DISTINCT r.installation_id) FROM release_reports r WHERE r.release_id = "releases"."id" AND r.status = ${status})`

export {
  lineReleases,
  normaliseArch,
  offerFor,
  parsePublicKey,
  pauseReason,
  releaseStats,
  reportCountSql,
  rolloutBucket,
  toDeviceOffer,
  toOfferSummary,
  toRelease,
  verifyReleaseSignature,
}
export type { Offer, ReleaseRow, ReleaseStats }
