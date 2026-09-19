import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COOLDOWN_SECONDS, DownloadTicketError, mintDownloadTicket, verifyDownloadTicket } from '@/lib/downloads'

const ticketFor = (overrides: Partial<Parameters<typeof mintDownloadTicket>[1]> = {}) =>
  mintDownloadTicket(env, { f: 'file-1', a: 'app-1', u: null, p: null, c: 'release', paid: false, ...overrides })

afterEach(() => {
  vi.useRealTimers()
})

describe('mintDownloadTicket', () => {
  it('starts a payer immediately and a non-payer after the cooldown', async () => {
    const now = Date.now()
    const paid = await ticketFor({ paid: true })
    const free = await ticketFor({ paid: false })

    expect(paid.availableAt.getTime()).toBeLessThanOrEqual(now + 1000)
    // The five seconds live in the credential, not in the page: there is nothing to skip past.
    expect(Math.round((free.availableAt.getTime() - paid.availableAt.getTime()) / 1000)).toBe(COOLDOWN_SECONDS)
  })

  it('measures the lifetime from the moment the ticket becomes usable', async () => {
    const { availableAt, expiresAt } = await ticketFor()
    expect(expiresAt.getTime()).toBeGreaterThan(availableAt.getTime())
  })
})

describe('verifyDownloadTicket', () => {
  it('returns the claims of a ticket that is good', async () => {
    const { ticket } = await ticketFor({ paid: true, u: 'buyer-1', p: 'purchase-1' })
    await expect(verifyDownloadTicket(env, ticket)).resolves.toMatchObject({
      f: 'file-1',
      a: 'app-1',
      u: 'buyer-1',
      p: 'purchase-1',
      paid: true,
    })
  })

  it('refuses a ticket whose cooldown has not elapsed, and accepts it once it has', async () => {
    const { ticket } = await ticketFor({ paid: false })

    await expect(verifyDownloadTicket(env, ticket)).rejects.toMatchObject({ reason: 'early' })

    vi.setSystemTime(Date.now() + (COOLDOWN_SECONDS + 1) * 1000)
    await expect(verifyDownloadTicket(env, ticket)).resolves.toMatchObject({ f: 'file-1' })
  })

  it('refuses an expired ticket', async () => {
    const { ticket, expiresAt } = await ticketFor({ paid: true })
    vi.setSystemTime(expiresAt.getTime() + 1000)
    await expect(verifyDownloadTicket(env, ticket)).rejects.toMatchObject({ reason: 'expired' })
  })

  it('refuses a tampered payload as a forgery rather than as a bad file', async () => {
    const { ticket } = await ticketFor({ paid: true })
    const [, signature] = ticket.split('.')
    const forged = `${btoa(JSON.stringify({ f: 'other-file', a: 'app-1', u: null, p: null, paid: true, nbf: 0, exp: 2 ** 31 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}.${signature}`

    await expect(verifyDownloadTicket(env, forged)).rejects.toMatchObject({ reason: 'signature' })
  })

  it('reports a shape that is not a ticket as malformed', async () => {
    await expect(verifyDownloadTicket(env, 'not-a-ticket')).rejects.toBeInstanceOf(DownloadTicketError)
    await expect(verifyDownloadTicket(env, 'not-a-ticket')).rejects.toMatchObject({ reason: 'malformed' })
  })

  it('reports an expired forgery as a forgery', async () => {
    // Order matters: checking the timestamps first would tell an attacker their signature might have
    // been fine.
    const forged = `${btoa(JSON.stringify({ f: 'file-1', a: 'app-1', u: null, p: null, paid: true, nbf: 0, exp: 1 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}.AAAA`
    await expect(verifyDownloadTicket(env, forged)).rejects.toMatchObject({ reason: 'signature' })
  })
})
