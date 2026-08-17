import { and, desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { invitations, roles } from '@/db/schema'
import type { AppEnv } from '@/env'
import { TTL } from '@/lib/config'
import { generateId } from '@/lib/crypto'
import { requirePermission } from '@/middleware/auth'
import { getApplication, getRedirectUris } from '@/services/applications'
import { getRequestContext, recordAudit } from '@/services/audit'
import { invitationTemplate, sendEmail } from '@/services/email'
import { toPublicInvitation } from '@/services/invitations'
import { normalizeEmail } from '@/services/users'

const app = new Hono<AppEnv>()

const listResponseSchema = v.object({
  code: v.literal(200),
  data: v.array(v.looseObject({ id: v.string(), email: v.string(), status: v.string() })),
})

app.get(
  '/invitations',
  describeRoute({
    description: 'Lists invitations, newest first, with a derived status of pending, accepted, expired or revoked.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Invitations', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      403: { description: 'Missing the invitations:read permission' },
    },
  }),
  requirePermission('invitations:read'),
  async (c) => {
    const rows = await getDb(c.env).select().from(invitations).orderBy(desc(invitations.createdAt)).limit(200)
    return c.json({ code: 200, data: rows.map(toPublicInvitation) })
  },
)

const createInvitationSchema = v.object({
  email: v.pipe(v.string(), v.trim(), v.email()),
  /** Null or omitted invites to every application; otherwise the invitation is scoped to one. */
  application_id: v.optional(v.nullable(v.string())),
  /** Role granted when the invitation is accepted, on top of the default roles. */
  role_id: v.optional(v.nullable(v.string())),
  expires_in_days: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(90))),
  /** Whether to email the invitation. Defaults to true when a login URL can be determined. */
  send_email: v.optional(v.boolean()),
  /** Where the recipient should go to sign in. Defaults to the application's first redirect URI. */
  login_url: v.optional(v.pipe(v.string(), v.url())),
})

app.post(
  '/invitations',
  describeRoute({
    description:
      'Invites an email address. Sign-up is invitation-only, so this is what lets a new address sign in at all — through either provider. An invitation is an allowlist entry for the address, not a secret link: it is consumed the first time that address completes a sign-in.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'The invitation was created' },
      403: { description: 'Missing the invitations:write permission' },
      404: { description: 'No such application or role' },
      409: { description: 'A pending invitation already exists for this address' },
    },
  }),
  requirePermission('invitations:write'),
  validator('json', createInvitationSchema),
  async (c) => {
    const actor = c.get('actor')
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const email = normalizeEmail(body.email)

    const application = body.application_id ? await getApplication(db, body.application_id) : null
    if (body.application_id && !application) {
      throw new HTTPException(404, { message: 'Application not found' })
    }

    if (body.role_id) {
      const [role] = await db.select().from(roles).where(eq(roles.id, body.role_id)).limit(1)
      if (!role) {
        throw new HTTPException(404, { message: 'Role not found' })
      }
    }

    const [duplicate] = await db
      .select({ id: invitations.id })
      .from(invitations)
      .where(and(eq(invitations.email, email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
      .limit(1)
    if (duplicate) {
      throw new HTTPException(409, { message: 'A pending invitation already exists for this address' })
    }

    const expiresInSeconds = (body.expires_in_days ?? TTL.invitation / 86400) * 86400
    const invitation = {
      id: generateId(),
      email,
      applicationId: body.application_id ?? null,
      roleId: body.role_id ?? null,
      invitedBy: actor.user.id,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      acceptedAt: null,
      acceptedByUserId: null,
      revokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    await db.insert(invitations).values(invitation)

    // The Worker has no idea where a client application's own login page lives, so fall back to the
    // origin of its first registered redirect URI rather than guessing a path.
    const fallbackLoginUrl = application
      ? getRedirectUris(application).map((uri) => new URL(uri).origin)[0]
      : undefined
    const loginUrl = body.login_url ?? fallbackLoginUrl
    const shouldSend = (body.send_email ?? true) && Boolean(loginUrl)

    if (shouldSend && loginUrl) {
      await sendEmail(
        c.env,
        email,
        await invitationTemplate({
          url: loginUrl,
          applicationName: application?.name ?? c.env.MAIL_FROM_NAME,
          invitedByName: actor.user.name ?? actor.user.email,
          expiresInDays: Math.round(expiresInSeconds / 86400),
          brandName: c.env.MAIL_FROM_NAME,
        }),
      )
    }

    await recordAudit(db, {
      event: 'invitation.created',
      userId: actor.user.id,
      applicationId: body.application_id ?? null,
      ...getRequestContext(c),
      metadata: { email, emailed: shouldSend },
    })

    return c.json({ code: 201, data: { ...toPublicInvitation(invitation), emailed: shouldSend } }, 201)
  },
)

app.delete(
  '/invitations/:id',
  describeRoute({
    description: 'Revokes a pending invitation, so the address can no longer sign up with it.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The invitation was revoked' },
      403: { description: 'Missing the invitations:write permission' },
      404: { description: 'No such pending invitation' },
    },
  }),
  requirePermission('invitations:write'),
  async (c) => {
    const actor = c.get('actor')
    const db = getDb(c.env)

    const revoked = await db
      .update(invitations)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(invitations.id, c.req.param('id')), isNull(invitations.revokedAt), isNull(invitations.acceptedAt)))
      .returning({ id: invitations.id, email: invitations.email })

    if (revoked.length === 0) {
      throw new HTTPException(404, { message: 'No pending invitation with that id' })
    }

    await recordAudit(db, {
      event: 'invitation.revoked',
      userId: actor.user.id,
      ...getRequestContext(c),
      metadata: { email: revoked[0]?.email },
    })

    return c.body(null, 204)
  },
)

export default app
