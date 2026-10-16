import { env } from 'cloudflare:test'
import { sign } from 'hono/jwt'
import { vi } from 'vitest'
import type { AccessTokenClaims } from '@/lib/jwks'

/**
 * Mints the access tokens the panel verifies offline, and publishes the matching key over a stand-in
 * for the `AUTH` binding — the only channel `lib/jwks.ts` reads the key set through.
 */

type Jwk = JsonWebKey & { kid: string; alg: string }
type KeyPair = { kid: string; publicJwk: Jwk; privateJwk: Jwk }

const exportJwk = async (key: CryptoKey, kid: string): Promise<Jwk> => ({
  ...((await crypto.subtle.exportKey('jwk', key)) as JsonWebKey),
  kid,
  alg: 'EdDSA',
})

const generateKeyPair = async (kid = 'custom-apps-test-key'): Promise<KeyPair> => {
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

/** The panel's one intended user, as the auth service mints them. */
const adminClaims = (overrides: Partial<AccessTokenClaims> = {}): AccessTokenClaims => {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: env.AUTH_ISSUER,
    sub: 'admin-1',
    aud: 'franciscosolis-custom-apps',
    exp: now + 900,
    iat: now - 5,
    jti: 'jti-1',
    sid: 'session-1',
    provider: 'google',
    email: 'fran@franciscosolis.cl',
    email_verified: true,
    name: 'Fran',
    picture: null,
    roles: ['custom-apps-admin'],
    permissions: ['custom-apps:admin'],
    ...overrides,
  }
}

const mintToken = async (overrides: Partial<AccessTokenClaims> = {}) =>
  sign(adminClaims(overrides) as unknown as Record<string, unknown>, (await testKeyPair()).privateJwk as never, 'EdDSA')

/** Publishes the file's key and returns headers carrying a token for `overrides`. */
const asAdmin = async (overrides: Partial<AccessTokenClaims> = {}): Promise<Record<string, string>> => {
  stubJwks([(await testKeyPair()).publicJwk])
  return {
    Authorization: `Bearer ${await mintToken(overrides)}`,
    'Content-Type': 'application/json',
    'CF-Connecting-IP': '203.0.113.7',
  }
}

export { adminClaims, asAdmin, generateKeyPair, mintToken, stubJwks, testKeyPair }
export type { Jwk, KeyPair }
