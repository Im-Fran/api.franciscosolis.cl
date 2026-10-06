import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { AppEnv } from '@/env'
import { requirePermission } from '@/middleware/auth'
import { getRequestContext, recordAudit } from '@/services/audit'
import { getSettings, updateSettings } from '@/services/settings'

const app = new Hono<AppEnv>()

const settingsSchema = v.object({
  code: v.literal(200),
  data: v.object({
    registration_open: v.boolean(),
  }),
})

app.get(
  '/settings',
  describeRoute({
    description:
      'The authentication settings. A key with no row yet answers its default, which is the behaviour this Worker had before the setting existed — `registration_open` therefore reads false on a database nobody has touched.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The settings', content: { 'application/json': { schema: resolver(settingsSchema) } } },
      403: { description: 'Missing the settings:read permission' },
    },
  }),
  requirePermission('settings:read'),
  async (c) => c.json({ code: 200, data: await getSettings(getDb(c.env)) }),
)

const updateSchema = v.object({
  registration_open: v.optional(v.boolean()),
})

app.patch(
  '/settings',
  describeRoute({
    description:
      'Changes the authentication settings and answers the whole resulting set. Only the keys present in the body are written. Opening registration lets an address nobody invited create an account on its first verified sign-in; closing it again refuses the next one, including a magic link that was emailed while it was open, because the setting is read again when the link is consumed. It never touches accounts that already exist.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The updated settings', content: { 'application/json': { schema: resolver(settingsSchema) } } },
      403: { description: 'Missing the settings:write permission' },
    },
  }),
  requirePermission('settings:write'),
  validator('json', updateSchema),
  async (c) => {
    const actor = c.get('actor')
    const body = c.req.valid('json')
    const db = getDb(c.env)

    const before = await getSettings(db)
    const after = await updateSettings(db, body, actor.user.id)

    // One row per change rather than one per request: the trail is read by asking what happened to
    // a setting, and "registration was opened" is the answer somebody is looking for.
    for (const key of Object.keys(after) as (keyof typeof after)[]) {
      if (before[key] !== after[key]) {
        await recordAudit(db, {
          event: 'settings.updated',
          userId: actor.user.id,
          applicationId: actor.applicationId,
          ...getRequestContext(c),
          metadata: { setting: key, from: before[key], to: after[key] },
        })
      }
    }

    return c.json({ code: 200, data: after })
  },
)

export default app
