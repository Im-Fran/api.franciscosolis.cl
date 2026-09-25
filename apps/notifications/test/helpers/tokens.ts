import { env } from 'cloudflare:test'
import { sign } from 'hono/jwt'
import { vi } from 'vitest'
import type { AccessTokenClaims } from '@/lib/jwks'

/**
 * Mints the access tokens this Worker verifies offline, and publishes the matching key over a
 * stand-in for the `AUTH` binding — the only channel `lib/jwks.ts` reads the key set through. Same
 * technique as `apps/support/test/helpers/tokens.ts`.
 */

type Jwk = JsonWebKey & { kid: string; alg: string }
type KeyPair = { kid: string; publicJwk: Jwk; privateJwk: Jwk }

const exportJwk = async (key: CryptoKey, kid: string): Promise<Jwk> => ({
  ...((await crypto.subtle.exportKey('jwk', key)) as JsonWebKey),
  kid,
  alg: 'EdDSA',
})

const generateKeyPair = async (kid = 'notifications-test-key'): Promise<KeyPair> => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  return {
    kid,
    publicJwk: { ...(await exportJwk(pair.publicKey, kid)), use: 'sig' },
    privateJwk: await exportJwk(pair.privateKey, kid),
  }
}

/**
 * One pair per test file: `lib/jwks.ts` memoises the key set for the life of the isolate, and a
 * second pair minted mid-file would fail as a signature mismatch.
 */
let filePair: KeyPair | null = null
const testKeyPair = async (): Promise<KeyPair> => (filePair ??= await generateKeyPair())

const stubJwks = (keys: Jwk[]) => {
  const fetchMock = vi.fn(async () => Response.json({ keys }))
  ;(env as { AUTH: Fetcher }).AUTH = { fetch: fetchMock } as unknown as Fetcher
  return fetchMock
}

/** A signed-in member of the public, as the website is minted one. */
const userClaims = (overrides: Partial<AccessTokenClaims> = {}): AccessTokenClaims => {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: env.AUTH_ISSUER,
    sub: 'user-1',
    aud: 'franciscosolis-web',
    exp: now + 900,
    iat: now - 5,
    jti: 'jti-1',
    sid: 'session-1',
    provider: 'magic_link',
    email: 'someone@example.test',
    email_verified: true,
    name: 'Someone',
    picture: null,
    roles: ['user'],
    permissions: [],
    ...overrides,
  }
}

const mintToken = async (overrides: Partial<AccessTokenClaims> = {}) =>
  sign(userClaims(overrides) as unknown as Record<string, unknown>, (await testKeyPair()).privateJwk as never, 'EdDSA')

/** Publishes the file's key and returns headers carrying a token for `overrides`. */
const asUser = async (overrides: Partial<AccessTokenClaims> = {}): Promise<Record<string, string>> => {
  stubJwks([(await testKeyPair()).publicJwk])
  return {
    Authorization: `Bearer ${await mintToken(overrides)}`,
    'Content-Type': 'application/json',
  }
}

export { asUser, generateKeyPair, mintToken, stubJwks, testKeyPair, userClaims }
export type { Jwk, KeyPair }
