import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute } from 'hono-openapi'
import * as v from 'valibot'
import { getDb, type Database } from '@/db/client'
import { apps, auditLogs, ciTokens, installations, releaseReports, releases } from '@/db/schema'
import type { AppEnv } from '@/env'
import { ARCHES, CHANNELS, PLATFORMS, RELEASE_STATUSES, RELEASES } from '@/lib/config'
import { iso, parseJsonArray } from '@/lib/json'
import { compareSemver, isSemver } from '@/lib/semver'
import { hashToken, randomToken, TOKEN_PREFIXES } from '@/lib/tokens'
import { optionalText, paginationQuery } from '@/lib/validation'
import { readOptionalJson, validate } from '@/lib/validate'
import { auditRow, diff, getActorContext, recordAudit } from '@/services/audit'
import { normaliseArch, offerFor, releaseStats, reportCountSql, toDeviceOffer, toRelease, type ReleaseRow } from '@/services/releases'
import type { AppRow } from '@/services/serialize'
import { syncApp } from '@/services/socket'
import { assertId, dataSchema, jsonContent, listSchema, notFound, page, panelErrors } from '@/panel/shared'

/**
 * Releases from the panel's side: the CI tokens that upload them, and everything a person decides
 * about one afterwards — publishing it, how far it rolls out, pausing, resuming, withdrawing, rolling a
 * line back. Every change reaches devices holding a socket at once and the rest on their next
 * heartbeat, through the update in the heartbeat answer.
 */
const app = new Hono<AppEnv>()

const looseSchema = v.looseObject({ id: v.string() })

const loadAppRow = async (db: Database, id: string): Promise<AppRow> => {
  const [row] = await db.select().from(apps).where(eq(apps.id, id)).limit(1)
  if (!row) throw notFound('App')
  return row
}

const loadRelease = async (db: Database, id: string): Promise<ReleaseRow> => {
  const [row] = await db.select().from(releases).where(eq(releases.id, id)).limit(1)
  if (!row) throw notFound('Release')
  return row
}

const pushToApp = (c: Context<AppEnv>, appId: string) => c.executionCtx.waitUntil(syncApp(c.env, appId))

/* ── CI tokens ─────────────────────────────────────────────────────────────── */

type CiTokenRow = typeof ciTokens.$inferSelect

const toCiToken = (row: CiTokenRow) => ({
  id: row.id,
  app_id: row.appId,
  label: row.label,
  token_prefix: row.tokenPrefix,
  last_used_at: iso(row.lastUsedAt),
  revoked_at: iso(row.revokedAt),
  revoked_by: row.revokedBy,
  created_by: row.createdBy,
  created_at: iso(row.createdAt),
})

app.get(
  '/apps/:appId/ci-tokens',
  describeRoute({
    description: "An app's CI tokens, newest first. Only their first characters are kept in view: the token itself is shown once, when it is created.",
    tags: ['Releases'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The tokens', content: jsonContent(dataSchema(v.array(looseSchema))) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const db = getDb(c.env)
    await loadAppRow(db, id)
    const rows = await db.select().from(ciTokens).where(eq(ciTokens.appId, id)).orderBy(desc(ciTokens.createdAt), desc(ciTokens.id))
    return c.json({ code: 200 as const, data: rows.map(toCiToken) })
  },
)

app.post(
  '/apps/:appId/ci-tokens',
  describeRoute({
    description: 'Creates a CI token for the app. The answer carries `token` — the only time it is ever shown; only its hash is stored. Put it in CI as a secret and upload with `Authorization: Bearer <token>`.',
    tags: ['Releases'],
    security: [{ bearerAuth: [] }],
    responses: { 201: { description: 'Created', content: jsonContent(dataSchema(looseSchema, 201)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const { label } = await readOptionalJson(c, v.object({ label: optionalText(120) }))
    const actor = getActorContext(c)
    const db = getDb(c.env)
    await loadAppRow(db, id)
    const token = randomToken(TOKEN_PREFIXES.ci, 32)
    const tokenId = crypto.randomUUID()
    await db.batch([
      db.insert(ciTokens).values({ id: tokenId, appId: id, label: label ?? null, tokenHash: await hashToken(token), tokenPrefix: token.slice(0, 12), createdBy: actor.actorEmail }),
      db.insert(auditLogs).values(auditRow({ event: 'ci_token.created', resourceType: 'app', resourceId: id, ...actor, metadata: { ci_token_id: tokenId, label: label ?? null } })),
    ])
    const [row] = await db.select().from(ciTokens).where(eq(ciTokens.id, tokenId))
    return c.json({ code: 201 as const, data: { ...toCiToken(row!), token } }, 201)
  },
)

app.post(
  '/ci-tokens/:tokenId/revoke',
  describeRoute({
    description: 'Revokes a CI token: the next upload with it is refused. Releases it uploaded are untouched.',
    tags: ['Releases'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Revoked', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('tokenId'), 'CI token')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const [row] = await db.select().from(ciTokens).where(eq(ciTokens.id, id)).limit(1)
    if (!row) throw notFound('CI token')
    if (!row.revokedAt) {
      await db.update(ciTokens).set({ revokedAt: new Date(), revokedBy: actor.actorEmail }).where(and(eq(ciTokens.id, id), isNull(ciTokens.revokedAt)))
      await recordAudit(db, { event: 'ci_token.revoked', resourceType: 'app', resourceId: row.appId, ...actor, metadata: { ci_token_id: id } })
    }
    const [after] = await db.select().from(ciTokens).where(eq(ciTokens.id, id))
    return c.json({ code: 200 as const, data: toCiToken(after!) })
  },
)

/* ── Releases ──────────────────────────────────────────────────────────────── */

const listColumns = {
  release: releases,
  installed: reportCountSql('installed'),
  healthOk: reportCountSql('health_ok'),
  rolledBack: reportCountSql('rolled_back'),
}

app.get(
  '/apps/:appId/releases',
  describeRoute({
    description: "An app's releases, newest first (by upload), with how many devices installed each, came up healthy on it and rolled it back.",
    tags: ['Releases'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The releases', content: jsonContent(listSchema(looseSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate(
    'query',
    v.object({
      channel: v.optional(v.picklist(CHANNELS)),
      platform: v.optional(v.picklist(PLATFORMS)),
      arch: v.optional(v.picklist(ARCHES)),
      status: v.optional(v.picklist(RELEASE_STATUSES)),
      ...paginationQuery,
    }),
  ),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const query = c.req.valid('query')
    const { limit, offset } = page(query)
    const db = getDb(c.env)
    await loadAppRow(db, id)
    const where = and(
      eq(releases.appId, id),
      query.channel ? eq(releases.channel, query.channel) : undefined,
      query.platform ? eq(releases.platform, query.platform) : undefined,
      query.arch ? eq(releases.arch, query.arch) : undefined,
      query.status ? eq(releases.status, query.status) : undefined,
    )
    const [rows, [total]] = await Promise.all([
      db.select(listColumns).from(releases).where(where).orderBy(desc(releases.createdAt), sql`${releases}.rowid DESC`).limit(limit).offset(offset),
      db.select({ count: sql<number>`COUNT(*)` }).from(releases).where(where),
    ])
    return c.json({
      code: 200 as const,
      data: rows.map((row) => ({ ...toRelease(row.release), installed_count: Number(row.installed), healthy_count: Number(row.healthOk), rolled_back_count: Number(row.rolledBack) })),
      pagination: { limit, offset, total: Number(total?.count ?? 0) },
    })
  },
)

/**
 * Installations on a release's line, and how many already run its version. The architecture is
 * compared after normalising what each device reported, the same way the offer does — `arm64` and
 * `aarch64` are one line — so it is filtered here rather than in SQL.
 */
const reach = async (db: D1Database, release: ReleaseRow) => {
  const { results } = await db
    .prepare("SELECT i.arch, i.app_version FROM installations i WHERE i.app_id = ? AND i.status = 'active' AND i.channel = ? AND i.platform = ?")
    .bind(release.appId, release.channel, release.platform)
    .all<{ arch: string | null; app_version: string | null }>()
  const anyArch = release.arch === 'any' || release.arch === 'universal'
  const line = results.filter((row) => anyArch || normaliseArch(row.arch) === release.arch)
  return {
    installations_on_line: line.length,
    installations_on_version: line.filter((row) => row.app_version !== null && compareSemver(row.app_version, release.version) === 0).length,
  }
}

const detail = async (db: D1Database, release: ReleaseRow) => ({ ...toRelease(release, { stats: await releaseStats(db, release) }), ...(await reach(db, release)) })

app.get(
  '/releases/:releaseId',
  describeRoute({
    description:
      'One release with its rollout numbers: devices that downloaded, installed, came up healthy on it (`health_ok`), rolled it back or failed, devices that crashed on it since it was published, and the rollback and crash rates the automatic pause is decided on.',
    tags: ['Releases'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The release', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('releaseId'), 'Release')
    return c.json({ code: 200 as const, data: await detail(c.env.DB, await loadRelease(getDb(c.env), id)) })
  },
)

const installationIds = v.pipe(v.array(v.pipe(v.string(), v.uuid())), v.maxLength(500), v.transform((ids) => [...new Set(ids)]))

/** Checks every id names an installation of the app. */
const assertInstallations = async (db: Database, appId: string, ids: string[]) => {
  if (ids.length === 0) return
  const rows = await db.select({ id: installations.id }).from(installations).where(and(eq(installations.appId, appId), inArray(installations.id, ids)))
  if (rows.length !== ids.length) throw new HTTPException(422, { message: 'installation_ids must all be installations of this app' })
}

app.patch(
  '/releases/:releaseId',
  describeRoute({
    description: "Edits a release's notes, its minimum version (devices below it must update before they carry on) or the installations it is offered to whatever the percentage says.",
    tags: ['Releases'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Updated', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, 422: { description: 'Unknown installation' }, ...panelErrors },
  }),
  validate(
    'json',
    v.object({
      notes: optionalText(RELEASES.maxNotesLength),
      min_version: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(64), v.check(isSemver, 'must be a semantic version')))),
      installation_ids: v.optional(installationIds),
    }),
  ),
  async (c) => {
    const id = assertId(c.req.param('releaseId'), 'Release')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadRelease(db, id)
    if (body.min_version && compareSemver(body.min_version, before.version) > 0) {
      throw new HTTPException(400, { message: 'min_version: cannot be above the release itself' })
    }
    if (body.installation_ids) await assertInstallations(db, before.appId, body.installation_ids)
    await db
      .update(releases)
      .set({
        ...(body.notes !== undefined && { notes: body.notes }),
        ...(body.min_version !== undefined && { minVersion: body.min_version }),
        ...(body.installation_ids !== undefined && { rolloutInstallations: JSON.stringify(body.installation_ids) }),
        updatedAt: new Date(),
      })
      .where(eq(releases.id, id))
    const after = await loadRelease(db, id)
    await recordAudit(db, { event: 'release.updated', resourceType: 'app', resourceId: before.appId, ...actor, metadata: { release_id: id, ...diff(toRelease(before), toRelease(after)) } })
    pushToApp(c, before.appId)
    return c.json({ code: 200 as const, data: await detail(c.env.DB, after) })
  },
)

/** Moves a release to `status`, from one of `from`, recording who and why. Answers the row after. */
const transition = async (
  c: Context<AppEnv>,
  release: ReleaseRow,
  to: ReleaseRow['status'],
  from: ReadonlyArray<ReleaseRow['status']>,
  event: Parameters<typeof recordAudit>[1]['event'],
  extra: Partial<typeof releases.$inferInsert> = {},
  reason: string | null = null,
) => {
  if (!from.includes(release.status)) {
    throw new HTTPException(409, { message: `A ${release.status} release cannot be moved to ${to}` })
  }
  const actor = getActorContext(c)
  const db = getDb(c.env)
  const now = new Date()
  const [updated] = await db
    .update(releases)
    .set({ status: to, statusChangedAt: now, statusReason: JSON.stringify({ by: actor.actorEmail, automatic: false, reason }), updatedAt: now, ...extra })
    .where(and(eq(releases.id, release.id), eq(releases.status, release.status)))
    .returning()
  if (!updated) throw new HTTPException(409, { message: 'The release changed while saving; reload and try again' })
  await recordAudit(db, {
    event,
    resourceType: 'app',
    resourceId: release.appId,
    ...actor,
    metadata: { release_id: release.id, version: release.version, before: { status: release.status, rollout_percent: release.rolloutPercent }, after: { status: to, rollout_percent: updated.rolloutPercent }, reason },
  })
  pushToApp(c, release.appId)
  return updated
}

const percentInput = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100))
const reasonSchema = v.object({ reason: optionalText(500) })

app.post(
  '/releases/:releaseId/publish',
  describeRoute({
    description: 'Publishes a draft to `rollout_percent` of its line (and to `installation_ids`, whatever the percentage). Start small — 10 % — and widen it with `/rollout` once the first devices report healthy.',
    tags: ['Releases'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Published', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, 409: { description: 'Not a draft' }, ...panelErrors },
  }),
  validate('json', v.object({ rollout_percent: percentInput, installation_ids: v.optional(installationIds) })),
  async (c) => {
    const id = assertId(c.req.param('releaseId'), 'Release')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const release = await loadRelease(db, id)
    if (body.installation_ids) await assertInstallations(db, release.appId, body.installation_ids)
    const updated = await transition(c, release, 'published', ['draft'], 'release.published', {
      rolloutPercent: body.rollout_percent,
      ...(body.installation_ids && { rolloutInstallations: JSON.stringify(body.installation_ids) }),
      publishedAt: new Date(),
      publishedBy: actor.actorEmail,
    })
    return c.json({ code: 200 as const, data: await detail(c.env.DB, updated) })
  },
)

app.post(
  '/releases/:releaseId/rollout',
  describeRoute({
    description: "Changes how far a published (or paused) release reaches: its percentage and, optionally, the installations offered it regardless. Narrowing it stops offering it to devices outside the new reach; it does not uninstall it anywhere.",
    tags: ['Releases'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Updated', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, 409: { description: 'Not published or paused' }, ...panelErrors },
  }),
  validate('json', v.object({ rollout_percent: v.optional(percentInput), installation_ids: v.optional(installationIds) })),
  async (c) => {
    const id = assertId(c.req.param('releaseId'), 'Release')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const release = await loadRelease(db, id)
    if (release.status !== 'published' && release.status !== 'paused') throw new HTTPException(409, { message: `A ${release.status} release has no rollout to change` })
    if (body.installation_ids) await assertInstallations(db, release.appId, body.installation_ids)
    await db
      .update(releases)
      .set({
        ...(body.rollout_percent !== undefined && { rolloutPercent: body.rollout_percent }),
        ...(body.installation_ids !== undefined && { rolloutInstallations: JSON.stringify(body.installation_ids) }),
        updatedAt: new Date(),
      })
      .where(eq(releases.id, id))
    const after = await loadRelease(db, id)
    await recordAudit(db, {
      event: 'release.rollout_changed',
      resourceType: 'app',
      resourceId: release.appId,
      ...actor,
      metadata: {
        release_id: id,
        version: release.version,
        before: { rollout_percent: release.rolloutPercent, installations: parseJsonArray(release.rolloutInstallations).length },
        after: { rollout_percent: after.rolloutPercent, installations: parseJsonArray(after.rolloutInstallations).length },
      },
    })
    pushToApp(c, release.appId)
    return c.json({ code: 200 as const, data: await detail(c.env.DB, after) })
  },
)

app.post(
  '/releases/:releaseId/pause',
  describeRoute({
    description: 'Stops offering a release to anybody new. Devices that already installed it keep it.',
    tags: ['Releases'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Paused', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, 409: { description: 'Not published' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('releaseId'), 'Release')
    const { reason } = await readOptionalJson(c, reasonSchema)
    const release = await loadRelease(getDb(c.env), id)
    const updated = await transition(c, release, 'paused', ['published'], 'release.paused', {}, reason ?? null)
    return c.json({ code: 200 as const, data: await detail(c.env.DB, updated) })
  },
)

app.post(
  '/releases/:releaseId/resume',
  describeRoute({
    description: 'Offers a paused release again, at the rollout it had. A release paused automatically pauses again on the next evaluation if its rates are still past the threshold — fix the cause first.',
    tags: ['Releases'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Resumed', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, 409: { description: 'Not paused' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('releaseId'), 'Release')
    const release = await loadRelease(getDb(c.env), id)
    const updated = await transition(c, release, 'published', ['paused'], 'release.resumed')
    return c.json({ code: 200 as const, data: await detail(c.env.DB, updated) })
  },
)

app.post(
  '/releases/:releaseId/withdraw',
  describeRoute({
    description: 'Pulls a release. Nobody is offered it any more, and devices running it are offered the newest earlier version of their line as a mandatory rollback.',
    tags: ['Releases'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Withdrawn', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, 409: { description: 'Not published or paused' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('releaseId'), 'Release')
    const { reason } = await readOptionalJson(c, reasonSchema)
    const release = await loadRelease(getDb(c.env), id)
    const updated = await transition(c, release, 'withdrawn', ['published', 'paused'], 'release.withdrawn', {}, reason ?? null)
    return c.json({ code: 200 as const, data: await detail(c.env.DB, updated) })
  },
)

app.post(
  '/releases/:releaseId/rollback',
  describeRoute({
    description:
      "Rolls a whole line back to this release: every published or paused release of the same app, channel, platform and architecture that is newer is withdrawn, and this one is published to the whole line. Devices on a newer version are offered this one as a mandatory rollback on their next heartbeat (at once, holding a socket).",
    tags: ['Releases'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Rolled back', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, 409: { description: 'A draft cannot be rolled back to' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('releaseId'), 'Release')
    const { reason } = await readOptionalJson(c, reasonSchema)
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const target = await loadRelease(db, id)
    if (target.status === 'draft') throw new HTTPException(409, { message: 'A draft was never installed anywhere; publish it instead' })
    const line = await db
      .select()
      .from(releases)
      .where(and(eq(releases.appId, target.appId), eq(releases.channel, target.channel), eq(releases.platform, target.platform), eq(releases.arch, target.arch), inArray(releases.status, ['published', 'paused'])))
    const newer = line.filter((row) => compareSemver(row.version, target.version) > 0)
    const now = new Date()
    const statusReason = JSON.stringify({ by: actor.actorEmail, automatic: false, reason: reason ?? null, rolled_back_to: target.version })
    await db.batch([
      db
        .update(releases)
        .set({ status: 'published', rolloutPercent: 100, statusChangedAt: now, statusReason, updatedAt: now, publishedAt: target.publishedAt ?? now, publishedBy: target.publishedBy ?? actor.actorEmail })
        .where(eq(releases.id, target.id)),
      db.insert(auditLogs).values(
        auditRow({
          event: 'release.rolled_back',
          resourceType: 'app',
          resourceId: target.appId,
          ...actor,
          metadata: { release_id: target.id, version: target.version, withdrawn: newer.map((row) => ({ release_id: row.id, version: row.version })), reason: reason ?? null },
        }),
      ),
      ...newer.map((row) => db.update(releases).set({ status: 'withdrawn', statusChangedAt: now, statusReason, updatedAt: now }).where(eq(releases.id, row.id))),
    ])
    pushToApp(c, target.appId)
    return c.json({ code: 200 as const, data: await detail(c.env.DB, await loadRelease(db, id)) })
  },
)

app.delete(
  '/releases/:releaseId',
  describeRoute({
    description: 'Deletes a draft and its artifact. A release that was ever published is history — withdraw it instead.',
    tags: ['Releases'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' }, 409: { description: 'Not a draft' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('releaseId'), 'Release')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const release = await loadRelease(db, id)
    if (release.status !== 'draft') throw new HTTPException(409, { message: 'Only a draft can be deleted; withdraw a published release instead' })
    await c.env.RELEASES.delete(release.objectKey)
    await db.delete(releases).where(eq(releases.id, id))
    await recordAudit(db, { event: 'release.deleted', resourceType: 'app', resourceId: release.appId, ...actor, metadata: { before: toRelease(release) } })
    return c.json({ code: 200 as const, data: { id, deleted: true } })
  },
)

app.get(
  '/releases/:releaseId/artifact',
  describeRoute({
    description: 'The artifact itself, for the panel to download and inspect.',
    tags: ['Releases'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The artifact' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('releaseId'), 'Release')
    const release = await loadRelease(getDb(c.env), id)
    const object = await c.env.RELEASES.get(release.objectKey)
    if (!object) throw notFound('Artifact')
    return new Response(object.body, {
      headers: {
        'Content-Type': release.contentType,
        'Content-Length': String(release.sizeBytes),
        'Content-Disposition': `attachment; filename="${release.filename.replace(/["\\]/g, '')}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  },
)

/* ── Reports ───────────────────────────────────────────────────────────────── */

type ReportRow = typeof releaseReports.$inferSelect

const toReport = (row: ReportRow, extra: { alias?: string | null; hostname?: string | null; version?: string } = {}) => ({
  id: row.id,
  release_id: row.releaseId,
  installation_id: row.installationId,
  installation_alias: extra.alias ?? null,
  installation_hostname: extra.hostname ?? null,
  ...(extra.version !== undefined ? { version: extra.version } : {}),
  status: row.status,
  from_version: row.fromVersion,
  detail: row.detail,
  created_at: iso(row.createdAt),
})

app.get(
  '/releases/:releaseId/reports',
  describeRoute({
    description: 'Every report devices sent about a release, newest first.',
    tags: ['Releases'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The reports', content: jsonContent(listSchema(v.looseObject({ id: v.number() }))) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('query', v.object(paginationQuery)),
  async (c) => {
    const id = assertId(c.req.param('releaseId'), 'Release')
    const { limit, offset } = page(c.req.valid('query'))
    const db = getDb(c.env)
    await loadRelease(db, id)
    const where = eq(releaseReports.releaseId, id)
    const [rows, [total]] = await Promise.all([
      db
        .select({ report: releaseReports, alias: installations.alias, hostname: installations.hostname })
        .from(releaseReports)
        .leftJoin(installations, eq(installations.id, releaseReports.installationId))
        .where(where)
        .orderBy(desc(releaseReports.id))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`COUNT(*)` }).from(releaseReports).where(where),
    ])
    return c.json({ code: 200 as const, data: rows.map((row) => toReport(row.report, row)), pagination: { limit, offset, total: Number(total?.count ?? 0) } })
  },
)

app.get(
  '/installations/:installationId/updates',
  describeRoute({
    description: 'What an installation would be offered right now (`offer`, null when nothing), and the update reports it sent, newest first.',
    tags: ['Releases'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The offer and the reports' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('query', v.object(paginationQuery)),
  async (c) => {
    const id = assertId(c.req.param('installationId'), 'Installation')
    const { limit, offset } = page(c.req.valid('query'))
    const db = getDb(c.env)
    const [row] = await db.select({ installation: installations, app: apps }).from(installations).innerJoin(apps, eq(apps.id, installations.appId)).where(eq(installations.id, id)).limit(1)
    if (!row) throw notFound('Installation')
    const where = eq(releaseReports.installationId, id)
    const [offer, reports, [total]] = await Promise.all([
      offerFor(db, { app: row.app, installation: row.installation }),
      db
        .select({ report: releaseReports, version: releases.version })
        .from(releaseReports)
        .innerJoin(releases, eq(releases.id, releaseReports.releaseId))
        .where(where)
        .orderBy(desc(releaseReports.id))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`COUNT(*)` }).from(releaseReports).where(where),
    ])
    return c.json({
      code: 200 as const,
      data: { offer: offer ? toDeviceOffer(offer, row.app) : null, reports: reports.map((report) => toReport(report.report, { version: report.version })) },
      pagination: { limit, offset, total: Number(total?.count ?? 0) },
    })
  },
)

export default app
