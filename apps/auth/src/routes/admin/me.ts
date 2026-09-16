import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver } from 'hono-openapi'
import * as v from 'valibot'
import type { AppEnv } from '@/env'
import { toPublicUser } from '@/services/users'

const app = new Hono<AppEnv>()

const meResponseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    user: v.looseObject({ id: v.string(), email: v.string() }),
    application_id: v.string(),
    roles: v.array(v.string()),
    permissions: v.array(v.string()),
  }),
})

/**
 * "Is this account admitted to the administration interface at all?", asked once instead of once
 * per panel.
 *
 * A live session and a seat in here are two different questions: the token settles the first, and
 * this settles the second. Without it a no-access account meets every panel failing with its own
 * 403 rather than one explicit screen.
 *
 * The gate is "holds at least one permission", not a named list: every slug in `permissions` is an
 * administration capability — the catalog exists only to guard these routes — so an account with
 * none of them has nothing to do here, and one with any of them has a panel to land on. Which
 * panels those are is still each route's own `requirePermission` to answer.
 */
app.get(
  '/me',
  describeRoute({
    description:
      'The caller as the administration API sees them: their profile, the application the token was minted for, and the roles and permissions they hold in it. Answers 403 for an account that holds no administration permission, so an interface can ask once rather than per panel.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The caller', content: { 'application/json': { schema: resolver(meResponseSchema) } } },
      403: { description: 'The account holds no administration permission' },
    },
  }),
  async (c) => {
    const actor = c.get('actor')
    if (actor.permissions.length === 0) {
      throw new HTTPException(403, { message: 'This account has no access to the administration API' })
    }

    return c.json({
      code: 200,
      data: {
        user: toPublicUser(actor.user),
        application_id: actor.applicationId,
        roles: actor.roles,
        permissions: actor.permissions,
      },
    })
  },
)

export default app
