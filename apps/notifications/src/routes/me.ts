import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import { and, count, desc, eq, isNull, lt, or } from 'drizzle-orm'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { notifications, pushSubscriptions } from '@/db/schema'
import type { AppEnv } from '@/env'
import type { NotificationData } from '@/lib/catalog'
import { isNotificationType, renderCopy } from '@/lib/catalog'
import type { Locale } from '@/lib/config'
import { CATEGORIES, EMAIL_FREQUENCIES, LOCALES, PAGINATION } from '@/lib/config'
import { requireUser } from '@/middleware/auth'
import { PREFERENCES_PATH } from '@/services/email'
import { pushToUser, registerSubscription } from '@/services/push'
import { getRecipient, toPreferences, updatePreferences, upsertRecipient } from '@/services/recipients'

/**
 * Everything a signed-in person can do with their own notifications: read them, mark them, delete
 * them, choose how they are told, and register the devices they want pushed to.
 *
 * Every query is scoped by `c.get('user').id`, the verified `sub`, and no route takes a user id from
 * the request. A notification id belonging to somebody else answers 404 exactly like one that does
 * not exist, so ids are not an oracle for whose they are.
 */
const app = new Hono<AppEnv>()

app.use('/me/*', requireUser)

/**
 * Every signed-in request refreshes what this Worker knows about the account. It is how somebody
 * who has never been the subject of an event — and so never had an address recorded by a producer —
 * starts receiving digests the day one arrives, and how a changed address reaches the next digest.
 *
 * Except on the unread count, which the website polls every minute from every open tab: a D1 write
 * per poll would buy nothing the next real page view does not already refresh.
 */
app.use('/me/*', async (c, next) => {
  if (c.req.path.endsWith('/unread-count')) {
    return next()
  }
  const user = c.get('user')
  await upsertRecipient(getDb(c.env), { userId: user.id, email: user.email, name: user.name })
  await next()
})

type NotificationRow = typeof notifications.$inferSelect

const parseData = (raw: string): NotificationData => {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** The public shape, with the text rendered in the language the caller asked for. */
const toNotification = (row: NotificationRow, locale: Locale) => {
  const data = parseData(row.data)
  const copy = isNotificationType(row.type) ? renderCopy(row.type, data, locale) : { title: row.type, body: '' }
  return {
    id: row.id,
    type: row.type,
    category: row.category,
    title: copy.title,
    body: copy.body,
    url: row.url,
    data,
    read_at: row.readAt ? row.readAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  }
}

/**
 * An opaque keyset cursor: the last row's arrival second and id. Keyset rather than offset because
 * the list grows at the top while somebody pages down it, and an offset would repeat a row every
 * time a notification arrived.
 */
const encodeCursor = (row: NotificationRow) =>
  btoa(`${Math.floor(row.createdAt.getTime() / 1000)}:${row.id}`).replace(/=+$/, '')

const decodeCursor = (cursor: string) => {
  try {
    const [seconds, id] = atob(cursor).split(':')
    const at = Number(seconds)
    if (!Number.isInteger(at) || !id) {
      return null
    }
    return { at: new Date(at * 1000), id }
  } catch {
    return null
  }
}

const localeQuery = v.optional(v.picklist(LOCALES))

/** `?locale` when given, otherwise the language stored for the account. */
const localeFor = async (c: { env: AppEnv['Bindings'] }, userId: string, requested: Locale | undefined) =>
  requested ?? toPreferences(await getRecipient(getDb(c.env), userId)).locale

const notificationSchema = v.object({
  id: v.string(),
  type: v.string(),
  category: v.string(),
  title: v.string(),
  body: v.string(),
  url: v.nullable(v.string()),
  data: v.record(v.string(), v.unknown()),
  read_at: v.nullable(v.string()),
  created_at: v.string(),
})

const listQuerySchema = v.object({
  locale: localeQuery,
  limit: v.optional(v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.minValue(1), v.maxValue(PAGINATION.maxLimit))),
  cursor: v.optional(v.pipe(v.string(), v.maxLength(200))),
  filter: v.optional(v.picklist(['all', 'unread'])),
  category: v.optional(v.picklist(CATEGORIES)),
})

const unreadCount = async (c: { env: AppEnv['Bindings'] }, userId: string) => {
  const row = await getDb(c.env)
    .select({ value: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .get()
  return row?.value ?? 0
}

app.get(
  '/me/notifications',
  describeRoute({
    description:
      'The signed-in account\'s notifications, newest first, with the text rendered in `?locale` (or the account\'s language). Pages with the opaque `next_cursor`; `unread` is the account-wide unread count, whatever the filter.',
    tags: ['Notifications'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'A page of notifications',
        content: {
          'application/json': {
            schema: resolver(
              v.object({
                code: v.literal(200),
                data: v.array(notificationSchema),
                next_cursor: v.nullable(v.string()),
                unread: v.number(),
              }),
            ),
          },
        },
      },
      401: { description: 'Missing or invalid access token' },
    },
  }),
  validator('query', listQuerySchema),
  async (c) => {
    const user = c.get('user')
    const query = c.req.valid('query')
    const limit = query.limit ?? PAGINATION.defaultLimit
    const cursor = query.cursor ? decodeCursor(query.cursor) : null
    if (query.cursor && !cursor) {
      throw new HTTPException(400, { message: 'The cursor is not one this service issued' })
    }

    const rows = await getDb(c.env)
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, user.id),
          query.filter === 'unread' ? isNull(notifications.readAt) : undefined,
          query.category ? eq(notifications.category, query.category) : undefined,
          cursor
            ? or(
                lt(notifications.createdAt, cursor.at),
                and(eq(notifications.createdAt, cursor.at), lt(notifications.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit + 1)
      .all()

    const page = rows.slice(0, limit)
    const locale = await localeFor(c, user.id, query.locale)
    return c.json({
      code: 200 as const,
      data: page.map((row) => toNotification(row, locale)),
      next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
      unread: await unreadCount(c, user.id),
    })
  },
)

app.get(
  '/me/notifications/unread-count',
  describeRoute({
    description: 'How many of the signed-in account\'s notifications are unread. What the website polls for its bell.',
    tags: ['Notifications'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The unread count',
        content: {
          'application/json': {
            schema: resolver(v.object({ code: v.literal(200), data: v.object({ unread: v.number() }) })),
          },
        },
      },
      401: { description: 'Missing or invalid access token' },
    },
  }),
  async (c) => c.json({ code: 200 as const, data: { unread: await unreadCount(c, c.get('user').id) } }),
)

const readAllSchema = v.optional(v.object({ category: v.optional(v.picklist(CATEGORIES)) }), {})

app.post(
  '/me/notifications/read-all',
  describeRoute({
    description: 'Marks every unread notification as read, or every unread one in `category`.',
    tags: ['Notifications'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'How many were marked' },
      401: { description: 'Missing or invalid access token' },
    },
  }),
  async (c) => {
    const user = c.get('user')
    const raw = await c.req.json().catch(() => ({}))
    const parsed = v.safeParse(readAllSchema, raw)
    if (!parsed.success) {
      throw new HTTPException(400, { message: 'Unknown category' })
    }
    const updated = await getDb(c.env)
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.userId, user.id),
          isNull(notifications.readAt),
          parsed.output.category ? eq(notifications.category, parsed.output.category) : undefined,
        ),
      )
      .returning({ id: notifications.id })
      .all()
    return c.json({ code: 200 as const, data: { updated: updated.length } })
  },
)

const findOwn = async (c: { env: AppEnv['Bindings'] }, userId: string, id: string) => {
  const row = await getDb(c.env)
    .select()
    .from(notifications)
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
    .get()
  if (!row) {
    throw new HTTPException(404, { message: 'No such notification' })
  }
  return row
}

const markRoute = (read: boolean) =>
  [
    describeRoute({
      description: read ? 'Marks one notification as read.' : 'Marks one notification as unread again.',
      tags: ['Notifications'],
      security: [{ bearerAuth: [] }],
      responses: {
        200: {
          description: 'The notification',
          content: {
            'application/json': { schema: resolver(v.object({ code: v.literal(200), data: notificationSchema })) },
          },
        },
        401: { description: 'Missing or invalid access token' },
        404: { description: 'No such notification on this account' },
      },
    }),
    validator('query', v.object({ locale: localeQuery })),
  ] as const

app.post('/me/notifications/:id/read', ...markRoute(true), async (c) => {
  const user = c.get('user')
  const current = await findOwn(c, user.id, c.req.param('id'))
  const row = current.readAt
    ? current
    : (await getDb(c.env)
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.id, current.id), eq(notifications.userId, user.id)))
        .returning()
        .get()) ?? current
  return c.json({ code: 200 as const, data: toNotification(row, await localeFor(c, user.id, c.req.valid('query').locale)) })
})

app.post('/me/notifications/:id/unread', ...markRoute(false), async (c) => {
  const user = c.get('user')
  const current = await findOwn(c, user.id, c.req.param('id'))
  const row =
    (await getDb(c.env)
      .update(notifications)
      .set({ readAt: null })
      .where(and(eq(notifications.id, current.id), eq(notifications.userId, user.id)))
      .returning()
      .get()) ?? current
  return c.json({ code: 200 as const, data: toNotification(row, await localeFor(c, user.id, c.req.valid('query').locale)) })
})

app.delete(
  '/me/notifications/:id',
  describeRoute({
    description:
      'Deletes one notification for good. Retention is otherwise indefinite, so this is the only way one ever goes away.',
    tags: ['Notifications'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Deleted' },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such notification on this account' },
    },
  }),
  async (c) => {
    const user = c.get('user')
    const deleted = await getDb(c.env)
      .delete(notifications)
      .where(and(eq(notifications.id, c.req.param('id')), eq(notifications.userId, user.id)))
      .returning({ id: notifications.id })
      .all()
    if (deleted.length === 0) {
      throw new HTTPException(404, { message: 'No such notification' })
    }
    return c.body(null, 204)
  },
)

const channelSchema = v.object({ push: v.boolean(), email: v.boolean() })

/**
 * Spelled out per category rather than built from `CATEGORIES`: a mapped object schema loses its
 * key types in valibot, and a new category is rare enough that adding one line here is the cheaper
 * price than a validator that would accept any key.
 */
const preferencesSchema = v.object({
  email_frequency: v.picklist(EMAIL_FREQUENCIES),
  categories: v.object({ account: channelSchema, support: channelSchema, marketplace: channelSchema }),
  locale: v.picklist(LOCALES),
})

const channelUpdateSchema = v.optional(v.strictObject({ push: v.optional(v.boolean()), email: v.optional(v.boolean()) }))

const preferencesUpdateSchema = v.strictObject({
  email_frequency: v.optional(v.picklist(EMAIL_FREQUENCIES)),
  categories: v.optional(
    v.strictObject({ account: channelUpdateSchema, support: channelUpdateSchema, marketplace: channelUpdateSchema }),
  ),
  locale: v.optional(v.picklist(LOCALES)),
})

app.get(
  '/me/preferences',
  describeRoute({
    description:
      'How the signed-in account is notified: the email frequency, push and email per category, and the language notifications are written in. In-site notifications are always on and have no switch.',
    tags: ['Preferences'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The preferences',
        content: {
          'application/json': { schema: resolver(v.object({ code: v.literal(200), data: preferencesSchema })) },
        },
      },
      401: { description: 'Missing or invalid access token' },
    },
  }),
  async (c) =>
    c.json({ code: 200 as const, data: toPreferences(await getRecipient(getDb(c.env), c.get('user').id)) }),
)

app.put(
  '/me/preferences',
  describeRoute({
    description:
      'Updates the preferences. Partial: send only what changed, down to one channel of one category. Changes apply to notifications that arrive afterwards; one already waiting for a digest keeps waiting.',
    tags: ['Preferences'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The preferences after the update',
        content: {
          'application/json': { schema: resolver(v.object({ code: v.literal(200), data: preferencesSchema })) },
        },
      },
      400: { description: 'An unknown frequency, category, channel or language' },
      401: { description: 'Missing or invalid access token' },
    },
  }),
  validator('json', preferencesUpdateSchema),
  async (c) => {
    const next = await updatePreferences(getDb(c.env), c.get('user').id, c.req.valid('json'))
    return c.json({ code: 200 as const, data: next })
  },
)

const subscriptionPublic = (row: typeof pushSubscriptions.$inferSelect) => ({
  id: row.id,
  user_agent: row.userAgent,
  created_at: row.createdAt.toISOString(),
  last_used_at: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
})

const subscriptionSchema = v.object({
  id: v.string(),
  user_agent: v.nullable(v.string()),
  created_at: v.string(),
  last_used_at: v.nullable(v.string()),
})

/** A push endpoint has to be an https URL; anything else is not a push service. */
const endpointSchema = v.pipe(
  v.string(),
  v.maxLength(2048),
  v.url(),
  v.check((value) => value.startsWith('https://'), 'A push endpoint must be an https URL'),
)

const base64UrlKey = (max: number) => v.pipe(v.string(), v.minLength(8), v.maxLength(max), v.regex(/^[A-Za-z0-9_-]+=*$/))

const subscribeSchema = v.object({
  endpoint: endpointSchema,
  keys: v.object({ p256dh: base64UrlKey(128), auth: base64UrlKey(64) }),
  // Truncated rather than refused: it is a label for the device list, and a long user agent is not
  // a reason to leave somebody without push.
  user_agent: v.optional(v.nullable(v.pipe(v.string(), v.transform((value) => value.slice(0, 300))))),
})

app.get(
  '/me/push-subscriptions',
  describeRoute({
    description: 'The devices registered for push on the signed-in account. Endpoints and keys are never returned.',
    tags: ['Push'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The devices',
        content: {
          'application/json': {
            schema: resolver(v.object({ code: v.literal(200), data: v.array(subscriptionSchema) })),
          },
        },
      },
      401: { description: 'Missing or invalid access token' },
    },
  }),
  async (c) => {
    const rows = await getDb(c.env)
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, c.get('user').id))
      .orderBy(desc(pushSubscriptions.createdAt))
      .all()
    return c.json({ code: 200 as const, data: rows.map(subscriptionPublic) })
  },
)

app.post(
  '/me/push-subscriptions',
  describeRoute({
    description:
      'Registers this browser for push, from the `PushSubscription` it produced (`subscription.toJSON()`). Idempotent on the endpoint; an endpoint registered by another account moves to this one.',
    tags: ['Push'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: {
        description: 'The registered device',
        content: {
          'application/json': { schema: resolver(v.object({ code: v.literal(201), data: subscriptionSchema })) },
        },
      },
      400: { description: 'Not a push subscription' },
      401: { description: 'Missing or invalid access token' },
      503: { description: 'Push is not configured on this deployment' },
    },
  }),
  validator('json', subscribeSchema),
  async (c) => {
    if (!c.env.VAPID_PRIVATE_KEY) {
      throw new HTTPException(503, { message: 'Push notifications are not configured on this deployment' })
    }
    const body = c.req.valid('json')
    const row = await registerSubscription(getDb(c.env), c.get('user').id, {
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      userAgent: body.user_agent ?? c.req.header('User-Agent')?.slice(0, 300) ?? null,
    })
    return c.json({ code: 201 as const, data: subscriptionPublic(row) }, 201)
  },
)

app.post(
  '/me/push-subscriptions/test',
  describeRoute({
    description: 'Sends a test push to every device on the signed-in account, so the website can prove the switch works.',
    tags: ['Push'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'How many devices accepted it' },
      401: { description: 'Missing or invalid access token' },
    },
  }),
  validator('query', v.object({ locale: localeQuery })),
  async (c) => {
    const user = c.get('user')
    const locale = await localeFor(c, user.id, c.req.valid('query').locale)
    const result = await pushToUser(getDb(c.env), c.env, user.id, {
      id: crypto.randomUUID(),
      type: 'test',
      title: locale === 'es' ? 'Las notificaciones funcionan' : 'Notifications are working',
      body:
        locale === 'es'
          ? 'Así se verán los avisos en este dispositivo.'
          : 'This is how notices will look on this device.',
      url: PREFERENCES_PATH,
      tag: 'test',
    })
    return c.json({ code: 200 as const, data: result })
  },
)

app.delete(
  '/me/push-subscriptions/:id',
  describeRoute({
    description: 'Stops pushing to one device. The browser should also call `unsubscribe()` on its side.',
    tags: ['Push'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Removed' },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such device on this account' },
    },
  }),
  async (c) => {
    const deleted = await getDb(c.env)
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.id, c.req.param('id')), eq(pushSubscriptions.userId, c.get('user').id)))
      .returning({ id: pushSubscriptions.id })
      .all()
    if (deleted.length === 0) {
      throw new HTTPException(404, { message: 'No such device' })
    }
    return c.body(null, 204)
  },
)

export default app
