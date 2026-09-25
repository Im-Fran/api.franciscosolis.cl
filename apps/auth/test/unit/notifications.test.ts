import { env } from 'cloudflare:test'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  formatLocation,
  formatTimestamp,
  notifyAccountAccess,
  providerDisplayName,
} from '@/services/notifications'
import { captureEmails, failEmails } from '../helpers/email'
import { captureNotifications, failNotifications } from '../helpers/queue'
import { createUser, uniqueEmail } from '../helpers/db'

const mailbox = captureEmails()
afterEach(() => {
  mailbox.sent.length = 0
})
afterAll(() => mailbox.restore())

describe('formatTimestamp', () => {
  it('spells the moment out and says which clock it is on', () => {
    const formatted = formatTimestamp(new Date('2026-09-17T14:32:00Z'))

    expect(formatted).toContain('2026')
    expect(formatted).toContain('14:32')
    expect(formatted.endsWith(' UTC')).toBe(true)
  })

  it('reads the instant in UTC rather than wherever the Worker happens to run', () => {
    // 23:30Z is the next day in Santiago and the previous one in Honolulu; only UTC gives one answer.
    expect(formatTimestamp(new Date('2026-09-17T23:30:00Z'))).toContain('17 Sept 2026')
  })
})

describe('formatLocation', () => {
  it('expands the country code the edge sends into a name people recognise', () => {
    expect(formatLocation({ country: 'CL', city: 'Santiago' })).toBe('Santiago, Chile')
  })

  it('reports whichever half is known on its own', () => {
    expect(formatLocation({ country: 'JP', city: null })).toBe('Japan')
    expect(formatLocation({ country: null, city: 'Valparaíso' })).toBe('Valparaíso')
  })

  it('keeps a region code rather than a name that says nothing', () => {
    // `QQ` is unassigned and comes back as itself; `ZZ` is the code CLDR names "Unknown Region",
    // which is no use to a reader deciding whether they were there. `Q1` is not even a region code.
    expect(formatLocation({ country: 'QQ', city: null })).toBe('QQ')
    expect(formatLocation({ country: 'ZZ', city: null })).toBe('ZZ')
    expect(formatLocation({ country: 'Q1', city: 'Somewhere' })).toBe('Somewhere, Q1')
  })

  it('answers null when the request could not be placed at all', () => {
    expect(formatLocation({ country: null, city: null })).toBeNull()
  })
})

describe('providerDisplayName', () => {
  it('names a provider the way the sign-in screen does', () => {
    expect(providerDisplayName('magic_link')).toBe('Magic Link')
    expect(providerDisplayName('google')).toBe('Google')
  })

  it('falls back to the stored value for a provider that no longer exists', () => {
    expect(providerDisplayName('retired')).toBe('retired')
  })
})

describe('notifyAccountAccess', () => {
  const CHROME_ON_MACOS =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

  const notify = async (overrides: Record<string, unknown> = {}) => {
    const user = await createUser({ email: uniqueEmail('notify'), name: 'Ada', locale: 'es' })
    await notifyAccountAccess(env, {
      event: 'sign_in',
      user,
      applicationName: 'franciscosolis.cl',
      provider: 'magic_link',
      occurredAt: new Date('2026-09-17T14:32:00Z'),
      ip: '203.0.113.24',
      userAgent: CHROME_ON_MACOS,
      country: 'CL',
      city: 'Santiago',
      ...overrides,
    })
    return user
  }

  describe('when the queue takes the event', () => {
    // Installed per block rather than at collection time: both blocks' bodies are collected before
    // either runs, and a fake installed there would be replaced by the next block's before use.
    let queue: ReturnType<typeof captureNotifications>
    beforeAll(() => {
      queue = captureNotifications()
    })
    afterEach(() => {
      queue.sent.length = 0
    })
    afterAll(() => queue.restore())

    it('publishes it for the account, with every detail already rendered', async () => {
      const user = await notify()

      expect(queue.sent).toHaveLength(1)
      const [event] = queue.sent
      expect(event).toMatchObject({
        version: 1,
        type: 'account.sign_in',
        user: { id: user.id, email: user.email, name: 'Ada', locale: 'es' },
        occurred_at: '2026-09-17T14:32:00.000Z',
        url: '/account/sessions',
        data: {
          application_name: 'franciscosolis.cl',
          provider_name: 'Magic Link',
          device: 'Chrome on macOS',
          location: 'Santiago, Chile',
          ip_address: '203.0.113.24',
        },
      })
      expect(event?.id).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('does not email as well, because how the holder hears about it is now their choice', async () => {
      await notify()

      expect(mailbox.sent).toHaveLength(0)
    })

    it('tells an authorization apart from a sign-in', async () => {
      await notify({ event: 'authorization' })

      expect(queue.sent[0]?.type).toBe('account.authorization')
    })

    it('leaves what it could not find out as null, for the consumer to say in the reader\'s language', async () => {
      await notify({ ip: null, userAgent: null, country: null, city: null })

      expect(queue.sent[0]?.data).toMatchObject({ device: null, location: null, ip_address: null })
    })

    it('mints a fresh idempotency key for every event', async () => {
      await notify()
      await notify()

      expect(new Set(queue.sent.map((event) => event.id)).size).toBe(2)
    })
  })

  describe('when the queue refuses the event', () => {
    let outage: ReturnType<typeof failNotifications>
    beforeAll(() => {
      outage = failNotifications()
    })
    afterAll(() => outage.restore())

    it('falls back to emailing the notice directly, because a security notice must not be lost', async () => {
      const user = await notify()
      const message = mailbox.last()

      expect(message.to).toEqual([user.email])
      expect(message.subject).toBe('New sign-in to franciscosolis.cl')
      expect(message.text).toContain('17 Sept 2026')
      expect(message.text).toContain('Chrome on macOS')
      expect(message.text).toContain('Santiago, Chile')
      expect(message.text).toContain('203.0.113.24')
      expect(message.text).toContain('Magic Link')
    })

    it('keeps the authorization wording in the fallback', async () => {
      await notify({ event: 'authorization' })
      const message = mailbox.last()

      expect(message.subject).toBe('franciscosolis.cl was authorized on your account')
      expect(message.text).toContain('already signed in')
    })

    it('says so plainly in the fallback when the request carried nothing to place or identify it', async () => {
      await notify({ ip: null, userAgent: null, country: null, city: null })
      const message = mailbox.last()

      expect(message.text).toContain('Device: Unknown')
      expect(message.text).toContain('Location: Unknown')
      expect(message.text).toContain('IP address: Unknown')
    })

    it('swallows a failed fallback too, because the sign-in it reports on has already happened', async () => {
      const broken = failEmails('mailbox full')
      try {
        await expect(notify()).resolves.toBeTruthy()
      } finally {
        broken.restore()
      }
    })
  })
})
