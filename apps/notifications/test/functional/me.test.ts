import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb } from '@/db/client'
import { ingestEvent } from '@/services/ingest'
import { captureEmail } from '../helpers/email'
import { installVapidKey, makeEvent, removeVapidKey } from '../helpers/events'
import { capturePushes, createBrowser } from '../helpers/push'
import { asUser } from '../helpers/tokens'

const API = 'https://notifications.test'

const call = async (path: string, init: RequestInit & { as?: Parameters<typeof asUser>[0] } = {}) => {
  const { as, ...rest } = init
  return SELF.fetch(`${API}${path}`, { ...rest, headers: { ...(await asUser(as)), ...(rest.headers ?? {}) } })
}

const seed = async (count: number, userId = 'user-1') => {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const event = makeEvent({
      user: { id: userId, locale: 'es' },
      type: 'support.ticket_reply',
      data: { reference: `FS-${1000 + i}`, subject: 'Ayuda', author_name: 'Fran' },
      url: `/tickets/FS-${1000 + i}`,
    })
    await ingestEvent(getDb(env), env, event)
    // Distinct arrival seconds, so the order under test is the order written.
    await env.DB.prepare('UPDATE notifications SET created_at = ? WHERE id = ?').bind(1_780_000_000 + i, event.id).run()
    ids.push(event.id)
  }
  return ids
}

describe('the gate', () => {
  it('refuses a request with no token', async () => {
    const response = await SELF.fetch(`${API}/me/notifications`)
    expect(response.status).toBe(401)
  })

  it('refuses a token minted for another application', async () => {
    const response = await call('/me/notifications', { as: { aud: 'franciscosolis-cms' } })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: 'Invalid access token: the token was not issued for this service' })
  })

  it('refuses a token from another issuer', async () => {
    const response = await call('/me/notifications', { as: { iss: 'https://api-dev.franciscosolis.cl/auth' } })
    expect(response.status).toBe(401)
  })
})

describe('reading notifications', () => {
  let email: ReturnType<typeof captureEmail>
  beforeEach(() => {
    email = captureEmail()
  })
  afterEach(() => {
    email.restore()
  })

  it('lists newest first, rendered in the requested language, with the unread count', async () => {
    await seed(2)
    const response = await call('/me/notifications?locale=en')
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const body = await response.json<{ data: Array<Record<string, unknown>>; unread: number; next_cursor: string | null }>()
    expect(body.unread).toBe(2)
    expect(body.next_cursor).toBeNull()
    expect(body.data.map((item) => item.title)).toEqual(['New reply on FS-1001', 'New reply on FS-1000'])
    expect(body.data[0]).toMatchObject({ category: 'support', url: '/tickets/FS-1001', read_at: null })
  })

  it('falls back to the account language', async () => {
    await seed(1)
    const body = await (await call('/me/notifications')).json<{ data: Array<{ title: string }> }>()
    expect(body.data[0].title).toBe('Nueva respuesta en FS-1000')
  })

  it('pages with a keyset cursor', async () => {
    await seed(5)
    const first = await (await call('/me/notifications?limit=2&locale=en')).json<{ data: Array<{ title: string }>; next_cursor: string }>()
    const second = await (
      await call(`/me/notifications?limit=2&locale=en&cursor=${first.next_cursor}`)
    ).json<{ data: Array<{ title: string }>; next_cursor: string }>()
    const third = await (
      await call(`/me/notifications?limit=2&locale=en&cursor=${second.next_cursor}`)
    ).json<{ data: Array<{ title: string }>; next_cursor: string | null }>()

    expect([...first.data, ...second.data, ...third.data].map((item) => item.title)).toEqual([
      'New reply on FS-1004',
      'New reply on FS-1003',
      'New reply on FS-1002',
      'New reply on FS-1001',
      'New reply on FS-1000',
    ])
    expect(third.next_cursor).toBeNull()
  })

  it('refuses a cursor it did not issue', async () => {
    expect((await call('/me/notifications?cursor=%%%')).status).toBe(400)
  })

  it('filters by unread and by category', async () => {
    const [first] = await seed(2)
    await call(`/me/notifications/${first}/read`, { method: 'POST' })
    await ingestEvent(getDb(env), env, makeEvent())

    const unread = await (await call('/me/notifications?filter=unread')).json<{ data: unknown[] }>()
    expect(unread.data).toHaveLength(2)
    const account = await (await call('/me/notifications?category=account')).json<{ data: Array<{ type: string }> }>()
    expect(account.data.map((item) => item.type)).toEqual(['account.sign_in'])
  })

  it('never shows one account another account\'s notifications', async () => {
    await seed(2, 'somebody-else')
    const body = await (await call('/me/notifications')).json<{ data: unknown[]; unread: number }>()
    expect(body.data).toHaveLength(0)
    expect(body.unread).toBe(0)
  })

  it('counts unread for the bell', async () => {
    await seed(3)
    const body = await (await call('/me/notifications/unread-count')).json()
    expect(body).toEqual({ code: 200, data: { unread: 3 } })
  })
})

describe('marking and deleting', () => {
  it('marks one read and unread again', async () => {
    const [id] = await seed(1)
    const read = await (await call(`/me/notifications/${id}/read`, { method: 'POST' })).json<{ data: { read_at: string | null } }>()
    expect(read.data.read_at).not.toBeNull()
    const unread = await (await call(`/me/notifications/${id}/unread`, { method: 'POST' })).json<{ data: { read_at: string | null } }>()
    expect(unread.data.read_at).toBeNull()
  })

  it('answers 404 for somebody else\'s notification, exactly as for a missing one', async () => {
    const [theirs] = await seed(1, 'somebody-else')
    const other = await call(`/me/notifications/${theirs}/read`, { method: 'POST' })
    const missing = await call(`/me/notifications/${crypto.randomUUID()}/read`, { method: 'POST' })
    expect(other.status).toBe(404)
    expect(await other.json()).toEqual(await missing.json())
    expect((await call(`/me/notifications/${theirs}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('marks all read, or all in one category', async () => {
    await seed(2)
    await ingestEvent(getDb(env), env, makeEvent())

    const support = await (
      await call('/me/notifications/read-all', { method: 'POST', body: JSON.stringify({ category: 'support' }) })
    ).json()
    expect(support).toEqual({ code: 200, data: { updated: 2 } })
    const rest = await (await call('/me/notifications/read-all', { method: 'POST' })).json()
    expect(rest).toEqual({ code: 200, data: { updated: 1 } })
  })

  it('deletes one for good', async () => {
    const [id] = await seed(1)
    expect((await call(`/me/notifications/${id}`, { method: 'DELETE' })).status).toBe(204)
    const body = await (await call('/me/notifications')).json<{ data: unknown[] }>()
    expect(body.data).toHaveLength(0)
  })
})

describe('preferences', () => {
  it('starts from the defaults: daily email, everything on', async () => {
    const body = await (await call('/me/preferences')).json()
    expect(body).toEqual({
      code: 200,
      data: {
        email_frequency: 'daily',
        categories: {
          account: { push: true, email: true },
          support: { push: true, email: true },
          marketplace: { push: true, email: true },
        },
        locale: 'en',
      },
    })
  })

  it('merges a partial update', async () => {
    await call('/me/preferences', { method: 'PUT', body: JSON.stringify({ email_frequency: 'weekly' }) })
    const body = await (
      await call('/me/preferences', {
        method: 'PUT',
        body: JSON.stringify({ categories: { marketplace: { push: false } }, locale: 'es' }),
      })
    ).json<{ data: Record<string, unknown> }>()
    expect(body.data).toEqual({
      email_frequency: 'weekly',
      categories: {
        account: { push: true, email: true },
        support: { push: true, email: true },
        marketplace: { push: false, email: true },
      },
      locale: 'es',
    })
  })

  it.each([
    ['an unknown frequency', { email_frequency: 'hourly' }],
    ['an unknown category', { categories: { newsletter: { email: true } } }],
    ['an unknown channel', { categories: { account: { sms: true } } }],
    ['an unknown key', { theme: 'dark' }],
  ])('refuses %s', async (_, body) => {
    expect((await call('/me/preferences', { method: 'PUT', body: JSON.stringify(body) })).status).toBe(400)
  })

  it('records the verified address from the token, so the account can be emailed', async () => {
    await call('/me/preferences', { as: { email: 'Me@Example.test' } })
    const row = await env.DB.prepare('SELECT email FROM recipients WHERE user_id = ?').bind('user-1').first()
    expect(row).toEqual({ email: 'me@example.test' })
  })

  it('does not record an address its provider did not verify', async () => {
    await call('/me/preferences', { as: { email: 'unverified@example.test', email_verified: false } })
    const row = await env.DB.prepare('SELECT email FROM recipients WHERE user_id = ?').bind('user-1').first()
    expect(row).toEqual({ email: null })
  })
})

describe('push devices', () => {
  beforeEach(async () => {
    await installVapidKey()
  })
  afterEach(() => {
    removeVapidKey()
    vi.unstubAllGlobals()
  })

  const register = async (as?: Parameters<typeof asUser>[0]) => {
    const browser = await createBrowser()
    const response = await call('/me/push-subscriptions', {
      method: 'POST',
      as,
      body: JSON.stringify({ ...browser.subscription, user_agent: 'Firefox on Linux' }),
    })
    return { browser, response }
  }

  it('registers, lists without endpoints or keys, and removes a device', async () => {
    const { response } = await register()
    expect(response.status).toBe(201)
    const { data } = await response.json<{ data: { id: string } }>()

    const list = await (await call('/me/push-subscriptions')).json<{ data: Array<Record<string, unknown>> }>()
    expect(list.data).toEqual([{ id: data.id, user_agent: 'Firefox on Linux', created_at: expect.any(String), last_used_at: null }])

    expect((await call(`/me/push-subscriptions/${data.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await call(`/me/push-subscriptions/${data.id}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('moves an endpoint to whichever account registered it last', async () => {
    const browser = await createBrowser()
    const body = JSON.stringify(browser.subscription)
    await call('/me/push-subscriptions', { method: 'POST', body, as: { sub: 'first' } })
    await call('/me/push-subscriptions', { method: 'POST', body, as: { sub: 'second' } })

    const rows = await env.DB.prepare('SELECT user_id FROM push_subscriptions').all()
    expect(rows.results).toEqual([{ user_id: 'second' }])
  })

  it('refuses something that is not a push subscription', async () => {
    const response = await call('/me/push-subscriptions', {
      method: 'POST',
      body: JSON.stringify({ endpoint: 'http://insecure.example/push', keys: { p256dh: 'abcdefgh', auth: 'abcdefgh' } }),
    })
    expect(response.status).toBe(400)
  })

  it('answers 503 while push is not configured', async () => {
    removeVapidKey()
    const { response } = await register()
    expect(response.status).toBe(503)
  })

  it('sends a test push to every device', async () => {
    const { pushes } = capturePushes()
    const { browser } = await register()

    const body = await (await call('/me/push-subscriptions/test?locale=es', { method: 'POST' })).json()

    expect(body).toEqual({ code: 200, data: { sent: 1, removed: 0, failed: 0 } })
    expect(await browser.decrypt(pushes[0].body)).toMatchObject({ title: 'Las notificaciones funcionan' })
  })
})
