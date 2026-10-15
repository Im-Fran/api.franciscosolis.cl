import { describe, expect, it } from 'vitest'
import { hashToken, randomToken, sriSha384, TOKEN_PREFIXES } from '@/lib/tokens'

describe('credentials', () => {
  it('carry their prefix and enough entropy', () => {
    const token = randomToken(TOKEN_PREFIXES.access)
    expect(token.startsWith('cat_')).toBe(true)
    // 32 bytes of base64url, no padding.
    expect(token).toMatch(/^cat_[A-Za-z0-9_-]{43}$/)
    expect(randomToken(TOKEN_PREFIXES.access)).not.toBe(token)
  })

  it('are stored as a SHA-256 hex digest', async () => {
    expect(await hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('compute a Subresource Integrity value', async () => {
    expect(await sriSha384('alert(1)')).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/)
  })
})
