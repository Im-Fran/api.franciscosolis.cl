import { describe, expect, it } from 'vitest'
import { TOKEN_PREFIXES, hashToken, randomToken } from '@/lib/tokens'
import { stateOf } from '@/panel/approval'
import type { LinkRow, MaintenanceRow } from '@/services/maintenances'

/**
 * An approval link's lifecycle, decided from its row and its maintenance's alone: it answers while
 * the maintenance waits on the client, before the first window it offered starts, until a later send
 * replaces it — and once it answered, that is what it says from then on, whatever happens next.
 */
const now = new Date('2026-11-02T12:00:00Z')
const link = (overrides: Partial<LinkRow> = {}) =>
  ({ id: 'l', maintenanceId: 'm', tokenHash: 'h', recipientEmail: 'ops@cliente.cl', send: 1, expiresAt: new Date('2026-11-05T05:00:00Z'), invalidatedAt: null, answer: null, answeredAt: null, createdAt: now, ...overrides }) as LinkRow
const maintenance = (status: string) => ({ status }) as MaintenanceRow

describe('an approval link', () => {
  it('is a prefixed random token stored only as its hash', async () => {
    const token = randomToken(TOKEN_PREFIXES.maintenance, 32)
    expect(token).toMatch(/^mnt_[A-Za-z0-9_-]{43}$/)
    expect(await hashToken(token)).toMatch(/^[0-9a-f]{64}$/)
    expect(randomToken(TOKEN_PREFIXES.maintenance, 32)).not.toBe(token)
  })

  it('answers while its maintenance waits, before it expires, until replaced', () => {
    expect(stateOf(link(), maintenance('pending_approval'), now)).toBe('open')
    expect(stateOf(link({ expiresAt: now }), maintenance('pending_approval'), now)).toBe('expired')
    expect(stateOf(link({ invalidatedAt: now }), maintenance('pending_approval'), now)).toBe('superseded')
    for (const status of ['scheduled', 'draft', 'cancelled', 'no_response', 'completed']) expect(stateOf(link(), maintenance(status), now)).toBe('closed')
  })

  it('says it was answered from then on', () => {
    const answered = link({ answer: 'approved', answeredAt: now, invalidatedAt: now })
    expect(stateOf(answered, maintenance('scheduled'), now)).toBe('answered')
    expect(stateOf(answered, maintenance('pending_approval'), new Date('2027-01-01T00:00:00Z'))).toBe('answered')
  })
})
