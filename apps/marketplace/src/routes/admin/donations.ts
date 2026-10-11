import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { AppEnv } from '@/env'
import { getActorContext, getRequestContext, recordAudit } from '@/services/audit'
import {
  getDonationSettings,
  toAdminDonationSettings,
  updateDonationSettings,
} from '@/services/donation-settings'

/**
 * The donation link's own administration: whether it is open, its bounds and whether it takes a
 * message.
 *
 * Its takings are *not* here. They are the general fund's sales, read, refunded and receipted through
 * `/admin/products/general/…` like any product's — this file is only the switches.
 */
const app = new Hono<AppEnv>()

const settingsSchema = v.looseObject({
  enabled: v.boolean(),
  minimum_amount: v.nullable(v.number()),
  maximum_enabled: v.boolean(),
  maximum_amount: v.nullable(v.number()),
  messages_enabled: v.boolean(),
  message_max_length: v.number(),
  updated_at: v.nullable(v.string()),
  updated_by: v.nullable(v.string()),
})

/** A bound in whole pesos, or null for none. The peso has no minor unit, so it is an integer. */
const boundInput = v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER)))

const patchSchema = v.object({
  enabled: v.optional(v.boolean()),
  minimum_amount: v.optional(boundInput),
  maximum_enabled: v.optional(v.boolean()),
  maximum_amount: v.optional(boundInput),
  messages_enabled: v.optional(v.boolean()),
})

app.get(
  '/donations/settings',
  describeRoute({
    description:
      'The donation link\'s settings: whether it is open, the smallest donation it takes and the largest one when a maximum is switched on (both in CLP, compared with the converted charge), and whether a donor may leave a message. `maximum_amount` is kept while the maximum is off, so switching it back on does not lose the figure.',
    tags: ['Admin · Donations'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The settings',
        content: { 'application/json': { schema: resolver(v.object({ code: v.literal(200), data: settingsSchema })) } },
      },
      401: { description: 'Missing or invalid access token' },
    },
  }),
  async (c) => {
    const settings = await getDonationSettings(getDb(c.env))
    return c.json({ code: 200, data: toAdminDonationSettings(settings) })
  },
)

app.patch(
  '/donations/settings',
  describeRoute({
    description:
      'Changes any of the donation link\'s settings; fields left out keep their value. Amounts are whole pesos, or null for none. Refused with 422 when a maximum is switched on without an amount, or when the minimum would be larger than the maximum in force. Recorded on the audit trail as `donations.settings_updated`. The public `GET /donations` is cached for a minute, so a change reaches the donation page within that.',
    tags: ['Admin · Donations'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The settings after the change',
        content: { 'application/json': { schema: resolver(v.object({ code: v.literal(200), data: settingsSchema })) } },
      },
      401: { description: 'Missing or invalid access token' },
      422: { description: 'The settings would contradict each other' },
    },
  }),
  validator('json', patchSchema),
  async (c) => {
    const changes = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')

    const result = await updateDonationSettings(db, changes, editor.email)
    if ('error' in result) {
      throw new HTTPException(422, { message: result.error })
    }

    await recordAudit(db, {
      event: 'donations.settings_updated',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'settings',
      resourceId: 'donations',
      metadata: { changes },
    })

    return c.json({ code: 200, data: toAdminDonationSettings(result.settings) })
  },
)

export default app
