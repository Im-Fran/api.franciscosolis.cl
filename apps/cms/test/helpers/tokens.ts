import { sign } from 'hono/jwt'
import { vi } from 'vitest'
import type { AccessTokenClaims } from '@/lib/jwks'

/**
 * Mints the access tokens the CMS verifies offline.
 *
 * The Worker never talks to the auth service: it fetches a JWKS and checks an EdDSA signature
 * against it. So a test only needs a key pair of its own plus a stubbed `fetch` that publishes the
 * public half — no auth Worker, no service binding.
 */

type Jwk = JsonWebKey & { kid: string; alg: string }
type KeyPair = { kid: string; publicJwk: Jwk; privateJwk: Jwk }

const DEFAULT_KID = 'cms-test-key'

const exportJwk = async (key: CryptoKey, kid: string): Promise<Jwk> => ({
  ...((await crypto.subtle.exportKey('jwk', key)) as JsonWebKey),
  kid,
  alg: 'EdDSA',
})

/** A fresh Ed25519 pair exported as JWKs, both halves tagged with `kid`. */
const generateKeyPair = async (kid: string = DEFAULT_KID): Promise<KeyPair> => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  return {
    kid,
    publicJwk: { ...(await exportJwk(pair.publicKey, kid)), use: 'sig' },
    privateJwk: await exportJwk(pair.privateKey, kid),
  }
}

/**
 * The signing pair for a whole test file.
 *
 * `lib/jwks.ts` memoises the fetched key set for the life of the isolate, and an isolate is a test
 * file. A second pair minted halfway through a file would be checked against the first pair's public
 * key and fail as a signature mismatch, so every file that just wants "a valid token" shares one.
 */
let filePair: KeyPair | null = null
const testKeyPair = async (): Promise<KeyPair> => (filePair ??= await generateKeyPair())

/**
 * Replaces global `fetch` with a JWKS endpoint serving `keys`. Returned so a test can assert on how
 * many times the Worker actually went out for the key set.
 */
const stubJwks = (keys: Jwk[]) => {
  const fetchMock = vi.fn(async () => Response.json({ keys }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Claims the auth Worker puts on an access token, with everything the CMS gate wants. */
const editorClaims = (overrides: Partial<AccessTokenClaims> = {}): AccessTokenClaims => {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: 'https://auth.test',
    sub: 'editor-1',
    aud: 'franciscosolis-cms',
    exp: now + 900,
    iat: now - 5,
    jti: 'jti-1',
    sid: 'session-1',
    provider: 'google',
    email: 'fran@franciscosolis.cl',
    email_verified: true,
    name: 'Francisco Solis',
    picture: null,
    roles: ['editor'],
    permissions: ['cms:write'],
    ...overrides,
  }
}

const mintToken = async (overrides: Partial<AccessTokenClaims> = {}, signWith?: Jwk): Promise<string> => {
  const key = signWith ?? (await testKeyPair()).privateJwk
  return sign(editorClaims(overrides) as unknown as Record<string, unknown>, key as never, 'EdDSA')
}

/** Signs exactly the payload given, defaults and all left out — for tokens missing a claim. */
const mintRawToken = async (payload: Record<string, unknown>, signWith?: Jwk): Promise<string> => {
  const key = signWith ?? (await testKeyPair()).privateJwk
  return sign(payload, key as never, 'EdDSA')
}

const base64url = (value: unknown) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')

/** Hand-assembles a token so the header can say things `sign` would never write. */
const forgeToken = (header: Record<string, unknown>, payload: Record<string, unknown>, signature = 'AAAA') =>
  `${base64url(header)}.${base64url(payload)}.${signature}`

/** Publishes the file's public key and returns headers carrying a token an editor would send. */
const asEditor = async (overrides: Partial<AccessTokenClaims> = {}): Promise<Record<string, string>> => {
  const { publicJwk } = await testKeyPair()
  stubJwks([publicJwk])
  return {
    Authorization: `Bearer ${await mintToken(overrides)}`,
    'Content-Type': 'application/json',
  }
}

export {
  DEFAULT_KID,
  asEditor,
  editorClaims,
  forgeToken,
  generateKeyPair,
  mintRawToken,
  mintToken,
  stubJwks,
  testKeyPair,
}
export type { Jwk, KeyPair }
