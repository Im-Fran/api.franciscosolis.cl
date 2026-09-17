import { and, desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { identities, sessions, users } from '@/db/schema'
import type { AppEnv } from '@/env'
import { hasRules, selectSessionsToPrune } from '@/lib/prune'
import { requireAuth } from '@/middleware/auth'
import { getRequestContext, recordAudit } from '@/services/audit'
import { revokeSession, toPublicSession } from '@/services/tokens'
import { toPublicUser } from '@/services/users'

const app = new Hono<AppEnv>()

app.use('/me', requireAuth)
app.use('/me/*', requireAuth)
app.use('/logout', requireAuth)

const userSchema = v.object({
  id: v.string(),
  email: v.string(),
  email_verified: v.boolean(),
  name: v.nullable(v.string()),
  given_name: v.nullable(v.string()),
  family_name: v.nullable(v.string()),
  picture: v.nullable(v.string()),
  locale: v.nullable(v.string()),
  status: v.string(),
  last_login_at: v.nullable(v.string()),
  created_at: v.string(),
  updated_at: v.string(),
})

const meResponseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    user: userSchema,
    application_id: v.string(),
    session_id: v.string(),
    roles: v.array(v.string()),
    permissions: v.array(v.string()),
  }),
})

app.get(
  '/me',
  describeRoute({
    description:
      'Profile of the authenticated user, together with the roles and permissions they hold for the application the access token was issued to. Roles and permissions are read live from the database, so they reflect changes made after the token was issued.',
    tags: ['Me'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The authenticated user',
        content: { 'application/json': { schema: resolver(meResponseSchema) } },
      },
      401: { description: 'Missing, invalid or revoked access token' },
    },
  }),
  (c) => {
    const actor = c.get('actor')
    return c.json({
      code: 200,
      data: {
        user: toPublicUser(actor.user),
        application_id: actor.applicationId,
        session_id: actor.sessionId,
        roles: actor.roles,
        permissions: actor.permissions,
      },
    })
  },
)

const updateMeSchema = v.object({
  name: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(120)))),
  given_name: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(120)))),
  family_name: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(120)))),
  /**
   * Deliberately un-settable, and refused loudly rather than ignored.
   *
   * A picture on this account is either one a sign-in provider vouches for or one an administrator
   * approved (`POST /me/avatar`). Leaving a free-form URL here would make the whole review step
   * optional — anybody could point their avatar at any image on the internet, moderated by nobody
   * and re-fetched from a host we do not control — so the field answers 400 with where to go
   * instead.
   */
  picture: v.optional(
    v.pipe(
      v.any(),
      v.check(
        () => false,
        'The profile picture cannot be set directly: upload one to POST /me/avatar, where it is published once a reviewer approves it',
      ),
    ),
  ),
  locale: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(20)))),
})

app.patch(
  '/me',
  describeRoute({
    description:
      'Updates the profile fields the user owns. Two are deliberately not among them: the email address, which is the identity key providers are matched on, and the picture, which is uploaded to `POST /me/avatar` and published only once a reviewer approves it.',
    tags: ['Me'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The updated user',
        content: { 'application/json': { schema: resolver(meResponseSchema) } },
      },
      401: { description: 'Missing, invalid or revoked access token' },
    },
  }),
  validator('json', updateMeSchema),
  async (c) => {
    const actor = c.get('actor')
    const body = c.req.valid('json')
    const db = getDb(c.env)

    const updated = {
      ...actor.user,
      // `undefined` means "not sent, leave alone"; an explicit null clears the field.
      name: body.name === undefined ? actor.user.name : body.name,
      givenName: body.given_name === undefined ? actor.user.givenName : body.given_name,
      familyName: body.family_name === undefined ? actor.user.familyName : body.family_name,
      locale: body.locale === undefined ? actor.user.locale : body.locale,
      updatedAt: new Date(),
    }

    await db
      .update(users)
      .set({
        name: updated.name,
        givenName: updated.givenName,
        familyName: updated.familyName,
        locale: updated.locale,
        updatedAt: updated.updatedAt,
      })
      .where(eq(users.id, actor.user.id))

    await recordAudit(db, {
      event: 'user.updated',
      userId: actor.user.id,
      applicationId: actor.applicationId,
      ...getRequestContext(c),
      metadata: { fields: Object.keys(body) },
    })

    return c.json({
      code: 200,
      data: {
        user: toPublicUser(updated),
        application_id: actor.applicationId,
        session_id: actor.sessionId,
        roles: actor.roles,
        permissions: actor.permissions,
      },
    })
  },
)

const identitiesResponseSchema = v.object({
  code: v.literal(200),
  data: v.array(
    v.object({
      id: v.string(),
      provider: v.string(),
      email: v.nullable(v.string()),
      last_used_at: v.nullable(v.string()),
      created_at: v.string(),
    }),
  ),
})

app.get(
  '/me/identities',
  describeRoute({
    description: 'Providers linked to the authenticated account.',
    tags: ['Me'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Linked identities',
        content: { 'application/json': { schema: resolver(identitiesResponseSchema) } },
      },
      401: { description: 'Missing, invalid or revoked access token' },
    },
  }),
  async (c) => {
    const actor = c.get('actor')
    const rows = await getDb(c.env).select().from(identities).where(eq(identities.userId, actor.user.id))

    return c.json({
      code: 200,
      data: rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        email: row.email,
        last_used_at: row.lastUsedAt?.toISOString() ?? null,
        created_at: row.createdAt.toISOString(),
      })),
    })
  },
)

const sessionSchema = v.object({
  id: v.string(),
  application_id: v.string(),
  provider: v.string(),
  ip: v.nullable(v.string()),
  user_agent: v.nullable(v.string()),
  country: v.nullable(v.string()),
  city: v.nullable(v.string()),
  current: v.boolean(),
  revoked_at: v.nullable(v.string()),
  last_seen_at: v.string(),
  created_at: v.string(),
})

const sessionsResponseSchema = v.object({
  code: v.literal(200),
  data: v.array(sessionSchema),
})

app.get(
  '/me/sessions',
  describeRoute({
    description:
      'Active sessions of the authenticated user across every application. The session the current access token belongs to is flagged with `current`.',
    tags: ['Me'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Active sessions',
        content: { 'application/json': { schema: resolver(sessionsResponseSchema) } },
      },
      401: { description: 'Missing, invalid or revoked access token' },
    },
  }),
  async (c) => {
    const actor = c.get('actor')
    const rows = await getDb(c.env)
      .select()
      .from(sessions)
      .where(eq(sessions.userId, actor.user.id))
      .orderBy(desc(sessions.lastSeenAt))

    return c.json({
      code: 200,
      data: rows.filter((row) => !row.revokedAt).map((row) => toPublicSession(row, actor.sessionId)),
    })
  },
)

/**
 * A day count a person would actually pick. The ceiling is ten years rather than unbounded so a
 * typo cannot be read as a rule that matches nothing at all.
 */
const days = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3650))

const pruneRequestSchema = v.object({
  rules: v.object({
    inactive_for_days: v.optional(days),
    older_than_days: v.optional(days),
    other_countries: v.optional(v.boolean()),
    other_networks: v.optional(v.boolean()),
    other_devices: v.optional(v.boolean()),
  }),
  scope: v.optional(
    v.object({
      applications: v.optional(v.array(v.string())),
      providers: v.optional(v.array(v.string())),
    }),
  ),
  /** `any`: a session matching one rule is closed. `all`: it has to match every rule selected. */
  match: v.optional(v.picklist(['any', 'all'])),
  /** Answers with the same list without revoking anything, so an interface can confirm first. */
  dry_run: v.optional(v.boolean()),
})

const pruneResponseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    dry_run: v.boolean(),
    match: v.picklist(['any', 'all']),
    matched: v.number(),
    revoked: v.number(),
    sessions: v.array(sessionSchema),
  }),
})

app.post(
  '/me/sessions/prune',
  describeRoute({
    description:
      'Closes every session of the authenticated user that matches the rules selected, in one call. ' +
      'Rules are evaluated relative to the session the access token belongs to, which is the one ' +
      'session the caller is demonstrably holding: `other_countries` means "a country other than the ' +
      'one I am signing in from right now", `other_networks` means "an address outside my current ' +
      '/24 (IPv4) or /48 (IPv6)", and `other_devices` means "a different browser or platform than ' +
      'this one". `inactive_for_days` reads `last_seen_at` and `older_than_days` reads `created_at`. ' +
      '`match` decides whether a session has to satisfy any rule (the default) or all of them, while ' +
      '`scope` narrows which sessions are considered at all and is always ANDed on top. ' +
      'The current session is never closed — signing out here stays `POST /logout` — a session ' +
      'missing the field a rule reads is never matched by that rule, and a request selecting no rule ' +
      'at all is refused rather than read as "close everything". Send `dry_run` to see exactly which ' +
      'sessions would go before committing to it.',
    tags: ['Me'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The sessions that were closed, or that would be for a dry run',
        content: { 'application/json': { schema: resolver(pruneResponseSchema) } },
      },
      400: { description: 'No rule was selected' },
      401: { description: 'Missing, invalid or revoked access token' },
    },
  }),
  validator('json', pruneRequestSchema),
  async (c) => {
    const actor = c.get('actor')
    const body = c.req.valid('json')
    const db = getDb(c.env)

    const rules = {
      inactiveForDays: body.rules.inactive_for_days,
      olderThanDays: body.rules.older_than_days,
      otherCountries: body.rules.other_countries,
      otherNetworks: body.rules.other_networks,
      otherDevices: body.rules.other_devices,
    }

    if (!hasRules(rules)) {
      throw new HTTPException(400, { message: 'Select at least one rule to prune by' })
    }

    const match = body.match ?? 'any'
    const dryRun = body.dry_run ?? false

    const rows = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, actor.user.id), isNull(sessions.revokedAt)))
      .orderBy(desc(sessions.lastSeenAt))

    const current = rows.find((row) => row.id === actor.sessionId)
    if (!current) {
      // `requireAuth` re-checks the session on every request, so this is unreachable in practice;
      // rather than fall back to pruning against nothing, refuse the run.
      throw new HTTPException(401, { message: 'The session behind this token is no longer active' })
    }

    const doomed = selectSessionsToPrune({
      sessions: rows,
      current,
      rules,
      scope: { applications: body.scope?.applications, providers: body.scope?.providers },
      match,
    })

    if (!dryRun) {
      // Sequentially rather than in parallel: D1 takes one statement at a time, and a partial run
      // is survivable here — the sessions already revoked stay revoked and the call is repeatable.
      for (const session of doomed) {
        await revokeSession(db, session.id, 'user_prune')
      }

      if (doomed.length > 0) {
        await recordAudit(db, {
          event: 'session.pruned',
          userId: actor.user.id,
          applicationId: actor.applicationId,
          ...getRequestContext(c),
          metadata: {
            match,
            rules: body.rules,
            scope: body.scope ?? null,
            revoked: doomed.length,
            session_ids: doomed.map((session) => session.id),
          },
        })
      }
    }

    return c.json({
      code: 200,
      data: {
        dry_run: dryRun,
        match,
        matched: doomed.length,
        revoked: dryRun ? 0 : doomed.length,
        sessions: doomed.map((session) => toPublicSession(session, actor.sessionId)),
      },
    })
  },
)

app.delete(
  '/me/sessions/:id',
  describeRoute({
    description:
      'Revokes one of the authenticated user\'s own sessions, invalidating its whole refresh token chain. Revoking the current session is the same as signing out.',
    tags: ['Me'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The session was revoked' },
      401: { description: 'Missing, invalid or revoked access token' },
      404: { description: 'No such session belongs to this user' },
    },
  }),
  async (c) => {
    const actor = c.get('actor')
    const sessionId = c.req.param('id')
    const db = getDb(c.env)

    const [session] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, actor.user.id)))
      .limit(1)

    if (!session) {
      throw new HTTPException(404, { message: 'Session not found' })
    }

    await revokeSession(db, session.id, 'user_revocation')
    await recordAudit(db, {
      event: 'session.revoked',
      userId: actor.user.id,
      applicationId: session.applicationId,
      ...getRequestContext(c),
      metadata: { session_id: session.id, self: true },
    })

    return c.body(null, 204)
  },
)

app.post(
  '/logout',
  describeRoute({
    description:
      'Signs out of the current session. The access token itself cannot be un-issued, but it stops being accepted immediately because every authenticated request re-checks that its session is still alive.',
    tags: ['Me'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The session was revoked' },
      401: { description: 'Missing, invalid or revoked access token' },
    },
  }),
  async (c) => {
    const actor = c.get('actor')
    const db = getDb(c.env)

    await revokeSession(db, actor.sessionId, 'logout')
    await recordAudit(db, {
      event: 'session.revoked',
      userId: actor.user.id,
      applicationId: actor.applicationId,
      ...getRequestContext(c),
      metadata: { session_id: actor.sessionId, reason: 'logout' },
    })

    return c.body(null, 204)
  },
)

export default app
