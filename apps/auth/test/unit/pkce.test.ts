import { describe, expect, it } from 'vitest'
import { base64UrlDecode } from '@/lib/crypto'
import { createPkcePair, deriveChallenge, isValidCodeVerifier, verifyPkce } from '@/lib/pkce'
import { OTHER_PKCE, RFC7636 } from '../helpers/pkce'

describe('deriveChallenge', () => {
  it('reproduces the RFC 7636 Appendix B vector', async () => {
    await expect(deriveChallenge(RFC7636.verifier)).resolves.toBe(RFC7636.challenge)
  })

  it('produces a 43-character base64url digest for any verifier length', async () => {
    for (const verifier of ['a', 'a'.repeat(43), 'a'.repeat(128)]) {
      const challenge = await deriveChallenge(verifier)
      expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(base64UrlDecode(challenge)).toHaveLength(32)
    }
  })

  it('is deterministic and sensitive to a single character', async () => {
    const [first, second, altered] = await Promise.all([
      deriveChallenge(RFC7636.verifier),
      deriveChallenge(RFC7636.verifier),
      deriveChallenge(`${RFC7636.verifier.slice(0, -1)}X`),
    ])

    expect(first).toBe(second)
    expect(altered).not.toBe(first)
  })
})

describe('createPkcePair', () => {
  it('returns a verifier that actually derives its own challenge', async () => {
    const pair = await createPkcePair()

    await expect(deriveChallenge(pair.codeVerifier)).resolves.toBe(pair.codeChallenge)
  })

  it('returns a verifier the specification would accept', async () => {
    const pair = await createPkcePair()

    expect(isValidCodeVerifier(pair.codeVerifier)).toBe(true)
  })

  it('never reuses a verifier', async () => {
    const pairs = await Promise.all(Array.from({ length: 25 }, () => createPkcePair()))

    expect(new Set(pairs.map((pair) => pair.codeVerifier)).size).toBe(25)
  })
})

describe('verifyPkce', () => {
  it('accepts a matching S256 pair', async () => {
    await expect(verifyPkce(RFC7636.verifier, RFC7636.challenge, 'S256')).resolves.toBe(true)
  })

  it('rejects a verifier that belongs to another challenge', async () => {
    await expect(verifyPkce(OTHER_PKCE.verifier, RFC7636.challenge, 'S256')).resolves.toBe(false)
  })

  it('rejects a challenge that is the verifier itself', async () => {
    await expect(verifyPkce(RFC7636.verifier, RFC7636.verifier, 'S256')).resolves.toBe(false)
  })

  it('rejects the plain method even when verifier and challenge are identical', async () => {
    // `plain` would make an intercepted authorization request replayable, so it is refused before
    // the values are even compared.
    await expect(verifyPkce(RFC7636.verifier, RFC7636.verifier, 'plain')).resolves.toBe(false)
    await expect(verifyPkce(RFC7636.verifier, RFC7636.challenge, 'plain')).resolves.toBe(false)
  })

  it('rejects an unknown or differently cased method', async () => {
    await expect(verifyPkce(RFC7636.verifier, RFC7636.challenge, 's256')).resolves.toBe(false)
    await expect(verifyPkce(RFC7636.verifier, RFC7636.challenge, '')).resolves.toBe(false)
    await expect(verifyPkce(RFC7636.verifier, RFC7636.challenge, 'S512')).resolves.toBe(false)
  })
})

describe('isValidCodeVerifier', () => {
  it('applies the 43-128 character bounds from RFC 7636 §4.1', () => {
    expect(isValidCodeVerifier('a'.repeat(42))).toBe(false)
    expect(isValidCodeVerifier('a'.repeat(43))).toBe(true)
    expect(isValidCodeVerifier('a'.repeat(128))).toBe(true)
    expect(isValidCodeVerifier('a'.repeat(129))).toBe(false)
    expect(isValidCodeVerifier('')).toBe(false)
  })

  it('accepts every unreserved character', () => {
    expect(isValidCodeVerifier(`${'-._~'.repeat(10)}abcXYZ012`)).toBe(true)
  })

  it('rejects characters outside the unreserved set', () => {
    const base = 'a'.repeat(42)

    for (const character of ['+', '/', '=', ' ', '%', '#', '?', '\n', 'é']) {
      expect(isValidCodeVerifier(`${base}${character}`)).toBe(false)
    }
  })

  it('rejects a valid verifier with trailing whitespace or a newline', () => {
    expect(isValidCodeVerifier(`${RFC7636.verifier} `)).toBe(false)
    expect(isValidCodeVerifier(`${RFC7636.verifier}\n`)).toBe(false)
  })

  it('accepts the published vector', () => {
    expect(isValidCodeVerifier(RFC7636.verifier)).toBe(true)
  })
})
