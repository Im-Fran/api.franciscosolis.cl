import { describe, expect, it } from 'vitest'
import { RELEASES } from '@/lib/config'
import { mintDownloadTicket, verifyDownloadTicket } from '@/lib/download-tickets'

const claims = { r: 'release-1', a: 'app-1', i: 'installation-1' }

describe('download tickets', () => {
  it('carry their claims and expire after the configured time', async () => {
    const now = new Date('2026-10-17T12:00:00Z')
    const { ticket, expiresAt } = await mintDownloadTicket('secret', claims, now)
    expect(expiresAt.getTime()).toBe(now.getTime() + RELEASES.downloadTtlSeconds * 1000)
    expect(await verifyDownloadTicket('secret', ticket, now)).toMatchObject(claims)
    expect(await verifyDownloadTicket('secret', ticket, new Date(expiresAt.getTime() + 1000))).toBeNull()
  })

  it('refuse another secret, a tampered payload and garbage alike', async () => {
    const { ticket } = await mintDownloadTicket('secret', claims)
    expect(await verifyDownloadTicket('other-secret', ticket)).toBeNull()
    const [payload, signature] = ticket.split('.')
    const forged = btoa(JSON.stringify({ ...claims, r: 'release-2', exp: 9_999_999_999 })).replace(/=+$/, '')
    expect(await verifyDownloadTicket('secret', `${forged}.${signature}`)).toBeNull()
    expect(await verifyDownloadTicket('secret', `${payload}`)).toBeNull()
    expect(await verifyDownloadTicket('secret', 'not-a-ticket')).toBeNull()
    expect(await verifyDownloadTicket('secret', '%%%.%%%')).toBeNull()
  })
})
