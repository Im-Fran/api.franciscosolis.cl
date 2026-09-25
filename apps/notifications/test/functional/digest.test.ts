import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '@/db/client'
import { runDigests } from '@/services/digest'
import { ingestEvent } from '@/services/ingest'
import { updatePreferences } from '@/services/recipients'
import { captureEmail } from '../helpers/email'
import { makeEvent } from '../helpers/events'

/** 09:00 in Santiago on a Wednesday in winter (UTC-4), and the Monday before it. */
const WEDNESDAY_9AM = new Date('2026-07-15T13:00:00Z')
const MONDAY_9AM = new Date('2026-07-13T13:00:00Z')
const WEDNESDAY_10AM = new Date('2026-07-15T14:00:00Z')

const status = async (id: string) =>
  (await env.DB.prepare('SELECT email_status FROM notifications WHERE id = ?').bind(id).first<{ email_status: string }>())
    ?.email_status

const notify = async (overrides: Parameters<typeof makeEvent>[0] = {}) => {
  const event = makeEvent(overrides)
  await ingestEvent(getDb(env), env, event)
  return event.id
}

describe('digests', () => {
  let email: ReturnType<typeof captureEmail>
  beforeEach(() => {
    email = captureEmail()
  })
  afterEach(() => {
    email.restore()
  })

  it('sends one daily digest listing every unread pending notification, in the recipient language', async () => {
    const first = await notify()
    const second = await notify({
      type: 'marketplace.release_published',
      data: { product_name: 'Backups', product_slug: 'backups', version: '2.0.0', channel: 'beta' },
      url: '/product/backups',
    })

    const result = await runDigests(getDb(env), env, WEDNESDAY_9AM)

    expect(result).toMatchObject({ periods: ['daily'], sent: 1, failed: 0 })
    expect(email.sent).toHaveLength(1)
    expect(email.sent[0].to).toEqual(['someone@example.test'])
    expect(email.sent[0].subject).toBe('Tu resumen diario: 2 notificaciones')
    expect(email.sent[0].text).toContain('Nuevo inicio de sesión en Francisco Solis')
    expect(email.sent[0].text).toContain('Ya está disponible Backups 2.0.0')
    expect(email.sent[0].html).toContain('https://franciscosolis.cl/product/backups')
    expect(await status(first)).toBe('sent')
    expect(await status(second)).toBe('sent')
  })

  it('leaves out what was already read on the site, and sends nothing if that was everything', async () => {
    const id = await notify()
    await env.DB.prepare('UPDATE notifications SET read_at = unixepoch() WHERE id = ?').bind(id).run()

    const result = await runDigests(getDb(env), env, WEDNESDAY_9AM)

    expect(result).toMatchObject({ sent: 0, skippedRead: 1 })
    expect(email.sent).toHaveLength(0)
    expect(await status(id)).toBe('skipped')
  })

  it('does nothing outside the digest hour', async () => {
    await notify()
    expect(await runDigests(getDb(env), env, WEDNESDAY_10AM)).toMatchObject({ periods: [], sent: 0 })
    expect(email.sent).toHaveLength(0)
  })

  it('never sends the same recipient two digests in one window', async () => {
    await notify()
    await runDigests(getDb(env), env, WEDNESDAY_9AM)
    await notify()
    await runDigests(getDb(env), env, new Date(WEDNESDAY_9AM.getTime() + 30 * 60 * 1000))

    expect(email.sent).toHaveLength(1)
  })

  it('sends weekly recipients theirs on Monday only', async () => {
    await updatePreferences(getDb(env), 'user-1', { email_frequency: 'weekly' })
    const id = await notify()

    await runDigests(getDb(env), env, WEDNESDAY_9AM)
    expect(email.sent).toHaveLength(0)
    expect(await status(id)).toBe('pending')

    const result = await runDigests(getDb(env), env, MONDAY_9AM)
    expect(result.periods).toEqual(['daily', 'weekly'])
    expect(email.sent).toHaveLength(1)
    expect(email.sent[0].subject).toBe('Tu resumen semanal: 1 notificación')
  })

  it('does not send a daily recipient a second email on Monday', async () => {
    await notify()
    await runDigests(getDb(env), env, MONDAY_9AM)
    expect(email.sent).toHaveLength(1)
  })

  it('retries an immediate email that failed, in the next daily run', async () => {
    await updatePreferences(getDb(env), 'user-1', { email_frequency: 'immediate' })
    email.failWith(new Error('mail is down'))
    const id = await notify()
    expect(await status(id)).toBe('pending')

    email.succeedWith('<ok@mail>')
    await runDigests(getDb(env), env, WEDNESDAY_9AM)

    expect(await status(id)).toBe('sent')
  })

  it('keeps rows pending when the digest itself cannot be sent', async () => {
    const id = await notify()
    email.failWith(new Error('mail is down'))

    const result = await runDigests(getDb(env), env, WEDNESDAY_9AM)

    expect(result).toMatchObject({ sent: 0, failed: 1 })
    expect(await status(id)).toBe('pending')
  })

  it('lists at most twenty and counts the rest', async () => {
    for (let i = 0; i < 23; i++) {
      await notify({ user: { id: 'user-1', email: 'someone@example.test', locale: 'en' } })
    }
    await runDigests(getDb(env), env, WEDNESDAY_9AM)
    expect(email.sent[0].subject).toBe('Your daily summary: 23 notifications')
    expect(email.sent[0].text).toContain('…and 3 more.')
    const pending = await env.DB.prepare("SELECT count(*) AS n FROM notifications WHERE email_status = 'pending'").first()
    expect(pending).toEqual({ n: 0 })
  })
})
