import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { applications, applicationSecrets } from '@/db/schema'
import type { AppEnv } from '@/env'
import { CLIENT_AUTH_METHODS, GRANT_TYPES, TTL } from '@/lib/config'
import { isOriginPattern, isRegisterableOrigin } from '@/lib/origins'
import { requirePermission } from '@/middleware/auth'
import {
  getAllowedOrigins,
  getGrantTypes,
  getPostLogoutRedirectUris,
  getRedirectUris,
  isConfidential,
  issueSecret,
  listSecrets,
  retireOtherSecrets,
  revokeSecret,
  SUPPORTED_SCOPES,
  toPublicSecret,
} from '@/services/applications'
import type { Application } from '@/services/applications'
import { getRequestContext, recordAudit } from '@/services/audit'

const app = new Hono<AppEnv>()

/** Never exposes a secret or its hash; `confidential` is all a caller needs to know about them. */
const toPublicApplication = (application: Application) => ({
  client_id: application.id,
  name: application.name,
  description: application.description,
  confidential: isConfidential(application),
  token_endpoint_auth_method: application.tokenEndpointAuthMethod,
  redirect_uris: getRedirectUris(application),
  post_logout_redirect_uris: getPostLogoutRedirectUris(application),
  grant_types: getGrantTypes(application),
  scopes: JSON.parse(application.scopes || '[]') as string[],
  require_pkce: application.requirePkce,
  allowed_origins: getAllowedOrigins(application),
  is_active: application.isActive,
  created_at: application.createdAt.toISOString(),
  updated_at: application.updatedAt.toISOString(),
})

const listResponseSchema = v.object({
  code: v.literal(200),
  data: v.array(v.looseObject({ client_id: v.string(), name: v.string() })),
})

app.get(
  '/applications',
  describeRoute({
    description: 'Lists registered client applications.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Applications', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      403: { description: 'Missing the applications:read permission' },
    },
  }),
  requirePermission('applications:read'),
  async (c) => {
    const rows = await getDb(c.env).select().from(applications).orderBy(desc(applications.createdAt))
    return c.json({ code: 200, data: rows.map(toPublicApplication) })
  },
)

/**
 * Redirect URIs are matched exactly, so they must be absolute and free of fragments — and free of
 * the `*.` pattern `allowed_origins` accepts, which would otherwise reach CORS through the origin
 * of the URI and, worse, read as a wildcard on where an authorization code may be sent.
 */
const redirectUriSchema = v.pipe(
  v.string(),
  v.url('Each redirect URI must be an absolute URL'),
  v.check((uri) => !uri.includes('#'), 'A redirect URI must not contain a fragment'),
  v.check((uri) => !isOriginPattern(uri), 'A redirect URI is matched exactly and cannot carry a wildcard'),
)

/**
 * An origin is a scheme and an authority, nothing else — what a browser puts in the Origin header.
 *
 * A leading `*.` label is also accepted, standing for any subdomain of the host it is anchored on:
 * that is how a Cloudflare preview deployment, whose hostname only exists once it is deployed, gets
 * to call this Worker. The wildcard has to leave at least two labels below it, and it never applies
 * to redirect URIs — see `lib/origins.ts` for the full rule and why it stops there.
 */
const originSchema = v.pipe(
  v.string(),
  v.url('Each allowed origin must be an absolute URL'),
  v.check(
    isRegisterableOrigin,
    'An allowed origin must be exactly scheme://host[:port], with no path, optionally starting with a *. label',
  ),
)

const authMethodSchema = v.picklist(CLIENT_AUTH_METHODS)
const grantTypesSchema = v.pipe(v.array(v.picklist(GRANT_TYPES)), v.minLength(1))
const scopesSchema = v.array(v.picklist(SUPPORTED_SCOPES))

const createApplicationSchema = v.object({
  client_id: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'client_id must be lowercase, alphanumeric or -')),
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  description: v.optional(v.nullable(v.string())),
  redirect_uris: v.pipe(v.array(redirectUriSchema), v.minLength(1)),
  post_logout_redirect_uris: v.optional(v.array(redirectUriSchema)),
  /** Shorthand for `token_endpoint_auth_method: 'client_secret_post'`, kept for compatibility. */
  confidential: v.optional(v.boolean()),
  token_endpoint_auth_method: v.optional(authMethodSchema),
  grant_types: v.optional(grantTypesSchema),
  scopes: v.optional(scopesSchema),
  require_pkce: v.optional(v.boolean()),
  allowed_origins: v.optional(v.array(originSchema)),
})

/**
 * Keeps the one invariant a client cannot be allowed to break: a public client always requires
 * PKCE, because the challenge is the only thing tying an authorization code to whoever asked for
 * it. Asking for both at once is refused; turning a client public while it happened to have PKCE
 * off re-arms PKCE rather than dead-ending the caller, since that is the direction that is safe.
 */
const resolvePkceRule = (authMethod: string, requirePkce: boolean, requestedExplicitly: boolean) => {
  if (requirePkce || authMethod !== 'none') {
    return requirePkce
  }
  if (requestedExplicitly) {
    throw new HTTPException(400, {
      message:
        'require_pkce can only be turned off for a confidential client — a public client has nothing else binding the code to it',
    })
  }
  return true
}

app.post(
  '/applications',
  describeRoute({
    description:
      'Registers a client application. A confidential client receives a generated `client_secret` in this response and nowhere else — only its hash is stored, so it cannot be read back later. Further secrets are issued through `POST /applications/:id/secrets`.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'The application was created' },
      400: { description: 'Invalid configuration' },
      403: { description: 'Missing the applications:write permission' },
      409: { description: 'That client_id is already taken' },
    },
  }),
  requirePermission('applications:write'),
  validator('json', createApplicationSchema),
  async (c) => {
    const actor = c.get('actor')
    const body = c.req.valid('json')
    const db = getDb(c.env)

    const [existing] = await db.select({ id: applications.id }).from(applications).where(eq(applications.id, body.client_id)).limit(1)
    if (existing) {
      throw new HTTPException(409, { message: 'That client_id is already registered' })
    }

    const authMethod =
      body.token_endpoint_auth_method ?? (body.confidential ? 'client_secret_post' : 'none')
    const requirePkce = resolvePkceRule(authMethod, body.require_pkce ?? true, body.require_pkce === false)

    const now = new Date()
    const application: Application = {
      id: body.client_id,
      name: body.name,
      description: body.description ?? null,
      tokenEndpointAuthMethod: authMethod,
      redirectUris: JSON.stringify(body.redirect_uris),
      postLogoutRedirectUris: JSON.stringify(body.post_logout_redirect_uris ?? []),
      grantTypes: JSON.stringify(body.grant_types ?? ['authorization_code', 'refresh_token']),
      scopes: JSON.stringify(body.scopes ?? []),
      requirePkce,
      allowedOrigins: JSON.stringify(body.allowed_origins ?? []),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    }
    await db.insert(applications).values(application)

    // A confidential client is useless without one, so the first secret comes with the client
    // rather than as a second call the caller could forget to make.
    const issued = authMethod === 'none' ? null : await issueSecret(db, {
      applicationId: application.id,
      label: 'Initial secret',
      createdBy: actor.user.id,
    })

    await recordAudit(db, {
      event: 'application.created',
      userId: actor.user.id,
      applicationId: application.id,
      ...getRequestContext(c),
      metadata: { token_endpoint_auth_method: authMethod, grant_types: body.grant_types ?? null },
    })

    return c.json(
      {
        code: 201,
        data: {
          ...toPublicApplication(application),
          client_secret: issued?.secret ?? null,
          ...(issued ? { secret: toPublicSecret(issued.record) } : {}),
        },
      },
      201,
    )
  },
)

const updateApplicationSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
  description: v.optional(v.nullable(v.string())),
  redirect_uris: v.optional(v.pipe(v.array(redirectUriSchema), v.minLength(1))),
  post_logout_redirect_uris: v.optional(v.array(redirectUriSchema)),
  token_endpoint_auth_method: v.optional(authMethodSchema),
  grant_types: v.optional(grantTypesSchema),
  scopes: v.optional(scopesSchema),
  require_pkce: v.optional(v.boolean()),
  allowed_origins: v.optional(v.array(originSchema)),
  is_active: v.optional(v.boolean()),
})

app.patch(
  '/applications/:id',
  describeRoute({
    description:
      'Updates a client application. Deactivating one stops new sign-ins immediately; tokens already issued keep working until they expire, and their sessions can be revoked separately. Turning a confidential client public revokes every secret it holds.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The updated application' },
      400: { description: 'Invalid configuration' },
      403: { description: 'Missing the applications:write permission' },
      404: { description: 'No such application' },
    },
  }),
  requirePermission('applications:write'),
  validator('json', updateApplicationSchema),
  async (c) => {
    const actor = c.get('actor')
    const body = c.req.valid('json')
    const db = getDb(c.env)

    const [application] = await db.select().from(applications).where(eq(applications.id, c.req.param('id'))).limit(1)
    if (!application) {
      throw new HTTPException(404, { message: 'Application not found' })
    }

    const authMethod = body.token_endpoint_auth_method ?? application.tokenEndpointAuthMethod
    const requirePkce = resolvePkceRule(
      authMethod,
      body.require_pkce ?? application.requirePkce,
      body.require_pkce === false,
    )

    const updated: Application = {
      ...application,
      name: body.name ?? application.name,
      description: body.description === undefined ? application.description : body.description,
      tokenEndpointAuthMethod: authMethod,
      redirectUris: body.redirect_uris ? JSON.stringify(body.redirect_uris) : application.redirectUris,
      postLogoutRedirectUris: body.post_logout_redirect_uris
        ? JSON.stringify(body.post_logout_redirect_uris)
        : application.postLogoutRedirectUris,
      grantTypes: body.grant_types ? JSON.stringify(body.grant_types) : application.grantTypes,
      scopes: body.scopes ? JSON.stringify(body.scopes) : application.scopes,
      requirePkce,
      allowedOrigins: body.allowed_origins ? JSON.stringify(body.allowed_origins) : application.allowedOrigins,
      isActive: body.is_active ?? application.isActive,
      updatedAt: new Date(),
    }

    await db
      .update(applications)
      .set({
        name: updated.name,
        description: updated.description,
        tokenEndpointAuthMethod: updated.tokenEndpointAuthMethod,
        redirectUris: updated.redirectUris,
        postLogoutRedirectUris: updated.postLogoutRedirectUris,
        grantTypes: updated.grantTypes,
        scopes: updated.scopes,
        requirePkce: updated.requirePkce,
        allowedOrigins: updated.allowedOrigins,
        isActive: updated.isActive,
        updatedAt: updated.updatedAt,
      })
      .where(eq(applications.id, application.id))

    // A public client authenticates with PKCE alone, so leaving live secrets behind it would mean
    // a value that still exists in the database but can no longer be presented anywhere.
    if (authMethod === 'none' && isConfidential(application)) {
      for (const secret of await listSecrets(db, application.id)) {
        if (!secret.revokedAt) {
          await revokeSecret(db, secret.id)
        }
      }
    }

    await recordAudit(db, {
      event: 'application.updated',
      userId: actor.user.id,
      applicationId: application.id,
      ...getRequestContext(c),
      metadata: { fields: Object.keys(body) },
    })

    return c.json({ code: 200, data: toPublicApplication(updated) })
  },
)

// ---------------------------------------------------------------------------- secrets

const secretsResponseSchema = v.object({
  code: v.literal(200),
  data: v.array(
    v.object({
      id: v.string(),
      hint: v.string(),
      label: v.nullable(v.string()),
      active: v.boolean(),
      expires_at: v.nullable(v.string()),
      last_used_at: v.nullable(v.string()),
      revoked_at: v.nullable(v.string()),
      created_at: v.string(),
    }),
  ),
})

app.get(
  '/applications/:id/secrets',
  describeRoute({
    description:
      'Lists the secrets of a client application, without their values — only their hash is stored, so nothing here can be turned back into a usable secret. `last_used_at` is the field that says whether an old secret is safe to revoke.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Secret metadata', content: { 'application/json': { schema: resolver(secretsResponseSchema) } } },
      403: { description: 'Missing the applications:read permission' },
      404: { description: 'No such application' },
    },
  }),
  requirePermission('applications:read'),
  async (c) => {
    const db = getDb(c.env)
    const [application] = await db.select().from(applications).where(eq(applications.id, c.req.param('id'))).limit(1)
    if (!application) {
      throw new HTTPException(404, { message: 'Application not found' })
    }

    const rows = await listSecrets(db, application.id)
    return c.json({ code: 200, data: rows.map((row) => toPublicSecret(row)) })
  },
)

const issueSecretSchema = v.object({
  label: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(120)))),
  /** Seconds until the new secret expires on its own. Omitted means it never does. */
  expires_in: v.optional(v.pipe(v.number(), v.integer(), v.minValue(60))),
  /**
   * Whether this issue is a rotation. When true the client's other secrets are given a deadline
   * instead of being cut off, so running deployments keep authenticating until they pick the new
   * value up. `grace_seconds: 0` ends them immediately, which is what a leak calls for.
   */
  rotate: v.optional(v.boolean()),
  grace_seconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
})

app.post(
  '/applications/:id/secrets',
  describeRoute({
    description:
      'Issues a client secret, returned in this response and nowhere else. With `rotate: true` the application\'s existing secrets are given an expiry `grace_seconds` from now (a week by default) rather than being revoked, so a rotation can be rolled out without downtime; pass `grace_seconds: 0` to end them at once, which is what a leaked secret calls for.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'The new secret, in plaintext, for the only time' },
      400: { description: 'This client is public and cannot hold a secret' },
      403: { description: 'Missing the applications:write permission' },
      404: { description: 'No such application' },
    },
  }),
  requirePermission('applications:write'),
  validator('json', issueSecretSchema),
  async (c) => {
    const actor = c.get('actor')
    const body = c.req.valid('json')
    const db = getDb(c.env)

    const [application] = await db.select().from(applications).where(eq(applications.id, c.req.param('id'))).limit(1)
    if (!application) {
      throw new HTTPException(404, { message: 'Application not found' })
    }
    if (!isConfidential(application)) {
      throw new HTTPException(400, {
        message:
          'This is a public client and authenticates with PKCE alone. Set token_endpoint_auth_method first, and only if it can actually keep a secret — a browser app cannot.',
      })
    }

    const issued = await issueSecret(db, {
      applicationId: application.id,
      label: body.label ?? null,
      expiresIn: body.expires_in ?? null,
      createdBy: actor.user.id,
    })

    const grace = body.grace_seconds ?? TTL.clientSecretGrace
    const retired = body.rotate ? await retireOtherSecrets(db, application.id, issued.record.id, grace) : 0

    await recordAudit(db, {
      event: body.rotate ? 'application.secret_rotated' : 'application.secret_issued',
      userId: actor.user.id,
      applicationId: application.id,
      ...getRequestContext(c),
      metadata: { secret_id: issued.record.id, retired, grace_seconds: body.rotate ? grace : null },
    })

    return c.json(
      {
        code: 201,
        data: {
          client_id: application.id,
          client_secret: issued.secret,
          retired_secrets: retired,
          ...toPublicSecret(issued.record),
        },
      },
      201,
    )
  },
)

app.delete(
  '/applications/:id/secrets/:secretId',
  describeRoute({
    description:
      'Revokes one secret of a client application, immediately. Revoking the last active secret of a confidential client locks it out of the token endpoint, so it is refused: make the client public, or issue a replacement first.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The secret was revoked' },
      400: { description: 'This is the last active secret of a confidential client' },
      403: { description: 'Missing the applications:write permission' },
      404: { description: 'No such application or secret' },
    },
  }),
  requirePermission('applications:write'),
  async (c) => {
    const actor = c.get('actor')
    const db = getDb(c.env)

    const [application] = await db.select().from(applications).where(eq(applications.id, c.req.param('id'))).limit(1)
    if (!application) {
      throw new HTTPException(404, { message: 'Application not found' })
    }

    const secrets = await listSecrets(db, application.id)
    const target = secrets.find((secret) => secret.id === c.req.param('secretId'))
    if (!target) {
      throw new HTTPException(404, { message: 'Secret not found' })
    }
    if (target.revokedAt) {
      return c.body(null, 204)
    }

    const now = Date.now()
    const stillActive = secrets.filter(
      (secret) =>
        secret.id !== target.id && !secret.revokedAt && (!secret.expiresAt || secret.expiresAt.getTime() > now),
    )
    if (stillActive.length === 0 && isConfidential(application)) {
      throw new HTTPException(400, {
        message: 'This is the last active secret of a confidential client; issue a replacement before revoking it',
      })
    }

    await revokeSecret(db, target.id)
    await recordAudit(db, {
      event: 'application.secret_revoked',
      userId: actor.user.id,
      applicationId: application.id,
      ...getRequestContext(c),
      metadata: { secret_id: target.id },
    })

    return c.body(null, 204)
  },
)

export default app
export { toPublicApplication }
