import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '@/index'
import { getDb } from '@/db/client'
import { ingestEvent } from '@/services/ingest'
import { registerSubscription } from '@/services/push'
import { updatePreferences } from '@/services/recipients'
import { captureEmail } from '../helpers/email'
import { installVapidKey, makeBatch, makeEvent, removeVapidKey } from '../helpers/events'
import { capturePushes, createBrowser, readVapid } from '../helpers/push'

const row = (id: string) =>
  env.DB.prepare('SELECT * FROM notifications WHERE id = ?').bind(id).first<Record<string, unknown>>()

const subscribe = async (userId = 'user-1') => {
  const browser = await createBrowser()
  await registerSubscription(getDb(env), userId, {
    endpoint: browser.subscription.endpoint,
    p256dh: browser.subscription.keys.p256dh,
    auth: browser.subscription.keys.auth,
    userAgent: 'test',
  })
  return browser
}

describe('ingesting an event', () => {
  let email: ReturnType<typeof captureEmail>

  beforeEach(async () => {
    email = captureEmail()
    await installVapidKey()
  })

  afterEach(() => {
    email.restore()
    removeVapidKey()
    vi.unstubAllGlobals()
  })

  it('stores the notification and learns the recipient', async () => {
    const event = makeEvent()
    expect(await ingestEvent(getDb(env), env, event)).toBe('created')

    expect(await row(event.id)).toMatchObject({
      user_id: 'user-1',
      type: 'account.sign_in',
      category: 'account',
      url: '/account/sessions',
      read_at: null,
      // The default frequency is daily, so it waits for the digest.
      email_status: 'pending',
    })
    const recipient = await env.DB.prepare('SELECT * FROM recipients WHERE user_id = ?').bind('user-1').first()
    expect(recipient).toMatchObject({ email: 'someone@example.test', locale: 'es', email_frequency: 'daily' })
    expect(email.sent).toHaveLength(0)
  })

  it('is a no-op for a redelivered event: nothing stored twice, nothing pushed twice', async () => {
    const { pushes } = capturePushes()
    await subscribe()
    const event = makeEvent()

    expect(await ingestEvent(getDb(env), env, event)).toBe('created')
    expect(await ingestEvent(getDb(env), env, event)).toBe('duplicate')

    const count = await env.DB.prepare('SELECT count(*) AS n FROM notifications').first<{ n: number }>()
    expect(count?.n).toBe(1)
    expect(pushes).toHaveLength(1)
  })

  it('pushes an encrypted payload, in the recipient language, to every device', async () => {
    const { pushes } = capturePushes()
    const phone = await subscribe()
    const laptop = await subscribe()
    const event = makeEvent()

    await ingestEvent(getDb(env), env, event)

    expect(pushes).toHaveLength(2)
    const byEndpoint = new Map(pushes.map((push) => [push.url, push]))
    const payload = await phone.decrypt(byEndpoint.get(phone.subscription.endpoint)!.body)
    expect(payload).toEqual({
      id: event.id,
      type: 'account.sign_in',
      title: 'Nuevo inicio de sesión en Francisco Solis',
      body: 'Ingreso con Magic Link desde Chrome on macOS · Santiago, Chile. ¿No fuiste tú? Cierra la sesión.',
      url: '/account/sessions',
      tag: `account.sign_in:${event.id}`,
    })
    await expect(laptop.decrypt(byEndpoint.get(laptop.subscription.endpoint)!.body)).resolves.toBeTruthy()

    const push = pushes[0]
    expect(push.headers.get('Content-Encoding')).toBe('aes128gcm')
    expect(push.headers.get('TTL')).toBe('86400')
    // A security notice is allowed to wake a phone.
    expect(push.headers.get('Urgency')).toBe('high')
    expect(push.headers.get('Topic')).toBe('account')
    expect(readVapid(push.headers.get('Authorization')!).payload).toMatchObject({
      aud: 'https://push.example.test',
      sub: 'mailto:hola@franciscosolis.cl',
    })
  })

  it('drops a subscription the push service says is gone, and keeps one that merely failed', async () => {
    const gone = await subscribe()
    const flaky = await subscribe()
    capturePushes((url) => (url === gone.subscription.endpoint ? 410 : 503))

    await ingestEvent(getDb(env), env, makeEvent())

    const rows = await env.DB.prepare('SELECT endpoint, failure_count FROM push_subscriptions').all()
    expect(rows.results).toEqual([{ endpoint: flaky.subscription.endpoint, failure_count: 1 }])
  })

  it('does not push a category the recipient turned push off for', async () => {
    const { pushes } = capturePushes()
    await subscribe()
    await updatePreferences(getDb(env), 'user-1', { categories: { account: { push: false } } })

    await ingestEvent(getDb(env), env, makeEvent())

    expect(pushes).toHaveLength(0)
  })

  it('does not push at all when no VAPID key is configured', async () => {
    const { pushes } = capturePushes()
    await subscribe()
    removeVapidKey()

    expect(await ingestEvent(getDb(env), env, makeEvent())).toBe('created')
    expect(pushes).toHaveLength(0)
  })

  it('emails an immediate recipient straight away, with the detailed security notice', async () => {
    await updatePreferences(getDb(env), 'user-1', { email_frequency: 'immediate' })
    const event = makeEvent()

    await ingestEvent(getDb(env), env, event)

    expect(email.sent).toHaveLength(1)
    expect(email.sent[0].to).toEqual(['someone@example.test'])
    expect(email.sent[0].subject).toBe('New sign-in to Francisco Solis')
    expect(email.sent[0].text).toContain('203.0.113.24')
    expect(await row(event.id)).toMatchObject({ email_status: 'sent' })
  })

  it('uses the generic template for everything else, in the recipient language', async () => {
    await updatePreferences(getDb(env), 'user-1', { email_frequency: 'immediate' })
    const event = makeEvent({
      type: 'marketplace.review_reply',
      data: { product_name: 'Backups', product_slug: 'backups' },
      url: '/product/backups',
    })

    await ingestEvent(getDb(env), env, event)

    expect(email.sent[0].subject).toBe('Respondieron tu reseña de Backups')
    expect(email.sent[0].html).toContain('https://franciscosolis.cl/product/backups')
    expect(email.sent[0].html).toContain('https://franciscosolis.cl/account/notifications')
  })

  it('leaves an immediate email pending for the next digest when the send fails', async () => {
    await updatePreferences(getDb(env), 'user-1', { email_frequency: 'immediate' })
    email.failWith(new Error('mail is down'))
    const event = makeEvent()

    expect(await ingestEvent(getDb(env), env, event)).toBe('created')
    expect(await row(event.id)).toMatchObject({ email_status: 'pending' })
  })

  it('never emails what its producer already emailed', async () => {
    await updatePreferences(getDb(env), 'user-1', { email_frequency: 'immediate' })
    const event = makeEvent({
      type: 'marketplace.purchase_completed',
      data: { product_name: 'Backups', product_slug: 'backups', amount: '$5.000 CLP' },
      url: '/account/purchases',
    })

    await ingestEvent(getDb(env), env, event)

    expect(email.sent).toHaveLength(0)
    expect(await row(event.id)).toMatchObject({ email_status: 'none' })
  })

  it.each([
    ['frequency never', { email_frequency: 'never' as const }],
    ['email off for the category', { categories: { account: { email: false } } }],
  ])('marks nothing for email with %s', async (_, update) => {
    await updatePreferences(getDb(env), 'user-1', update)
    const event = makeEvent()
    await ingestEvent(getDb(env), env, event)
    expect(await row(event.id)).toMatchObject({ email_status: 'none' })
  })

  it('marks nothing for email when there is no address to send to', async () => {
    const event = makeEvent({ user: { id: 'user-2' } })
    await ingestEvent(getDb(env), env, event)
    expect(await row(event.id)).toMatchObject({ email_status: 'none' })
  })

  it('keeps only a path, never an absolute or protocol-relative URL', async () => {
    const absolute = makeEvent({ url: 'https://evil.example/phish' })
    const protocolRelative = makeEvent({ url: '//evil.example/phish' })
    await ingestEvent(getDb(env), env, absolute)
    await ingestEvent(getDb(env), env, protocolRelative)
    expect((await row(absolute.id))?.url).toBeNull()
    expect((await row(protocolRelative.id))?.url).toBeNull()
  })

  it('caps long strings so a producer bug cannot fill a push payload', async () => {
    const event = makeEvent({ data: { application_name: 'x'.repeat(1000) } })
    await ingestEvent(getDb(env), env, event)
    const stored = JSON.parse(String((await row(event.id))?.data))
    expect(stored.application_name).toHaveLength(300)
  })
})

describe('the queue consumer', () => {
  let email: ReturnType<typeof captureEmail>
  beforeEach(() => {
    email = captureEmail()
  })
  afterEach(() => {
    email.restore()
  })

  it('acks what it stored, acks what is malformed, and retries an unknown type', async () => {
    const { batch, messages } = makeBatch([
      makeEvent(),
      { version: 1, id: 'nope' },
      makeEvent({ type: 'account.something_new' }),
    ])

    await worker.queue(batch, env, {} as ExecutionContext)

    expect(messages[0].ack).toHaveBeenCalled()
    expect(messages[1].ack).toHaveBeenCalled()
    expect(messages[2].retry).toHaveBeenCalledWith({ delaySeconds: 60 })
    expect(messages[2].ack).not.toHaveBeenCalled()
  })

  it('retries one message that throws without failing the rest of the batch', async () => {
    const original = env.DB
    const good = makeEvent()
    const { batch, messages } = makeBatch([makeEvent({ user: { id: 'boom' } }), good])
    let calls = 0
    ;(env as { DB: D1Database }).DB = new Proxy(original, {
      get(target, property, receiver) {
        if (property === 'prepare' && calls++ === 0) {
          return () => {
            throw new Error('D1 is unavailable')
          }
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    try {
      await worker.queue(batch, env, {} as ExecutionContext)
    } finally {
      ;(env as { DB: D1Database }).DB = original
    }

    expect(messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 30 })
    expect(messages[1].ack).toHaveBeenCalled()
    expect(await row(good.id)).not.toBeNull()
  })
})
