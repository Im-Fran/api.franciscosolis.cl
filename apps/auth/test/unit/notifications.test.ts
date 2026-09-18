import { env } from 'cloudflare:test'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  formatLocation,
  formatTimestamp,
  notifyAccountAccess,
  providerDisplayName,
} from '@/services/notifications'
import { captureEmails } from '../helpers/email'
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
  const notification = async (overrides: Record<string, unknown> = {}) => {
    const user = await createUser({ email: uniqueEmail('notify') })
    await notifyAccountAccess(env, {
      event: 'sign_in',
      user,
      applicationName: 'franciscosolis.cl',
      provider: 'magic_link',
      occurredAt: new Date('2026-09-17T14:32:00Z'),
      ip: '203.0.113.24',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      country: 'CL',
      city: 'Santiago',
      ...overrides,
    })
    return { user, message: mailbox.last() }
  }

  it('writes to the account itself, with every detail of the access filled in', async () => {
    const { user, message } = await notification()

    expect(message.to).toEqual([user.email])
    expect(message.subject).toBe('New sign-in to franciscosolis.cl')
    expect(message.text).toContain('17 Sept 2026')
    expect(message.text).toContain('Chrome on macOS')
    expect(message.text).toContain('Santiago, Chile')
    expect(message.text).toContain('203.0.113.24')
    expect(message.text).toContain('Magic Link')
  })

  it('tells an authorization apart from a sign-in, which is the whole reason it exists', async () => {
    const { message } = await notification({ event: 'authorization' })

    expect(message.subject).toBe('franciscosolis.cl was authorized on your account')
    expect(message.text).toContain('already signed in')
  })

  it('says so plainly when the request carried nothing to place or identify it', async () => {
    const { message } = await notification({ ip: null, userAgent: null, country: null, city: null })

    expect(message.text).toContain('Device: Unknown')
    expect(message.text).toContain('Location: Unknown')
    expect(message.text).toContain('IP address: Unknown')
  })

  it('swallows a delivery failure, because the sign-in it reports on has already happened', async () => {
    const original = env.EMAIL.send
    env.EMAIL.send = async () => {
      throw new Error('mailbox full')
    }

    const user = await createUser({ email: uniqueEmail('notify-fail') })
    await expect(
      notifyAccountAccess(env, {
        event: 'sign_in',
        user,
        applicationName: 'franciscosolis.cl',
        provider: 'magic_link',
        occurredAt: new Date(),
        ip: null,
        userAgent: null,
        country: null,
        city: null,
      }),
    ).resolves.toBeUndefined()

    env.EMAIL.send = original
  })
})
