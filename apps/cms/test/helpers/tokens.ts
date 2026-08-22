import { env } from 'cloudflare:test'
import { sign } from 'hono/jwt'
import { vi } from 'vitest'
import type { AccessTokenClaims } from '@/lib/jwks'

/**
 * Mints the access tokens the CMS verifies offline.
 *
 * The Worker never asks the auth service about a token: it reads a JWKS and checks an EdDSA
 * signature against it. So a test only needs a key pair of its own plus a stand-in for the `AUTH`
 * service binding that publishes the public half — no auth Worker.
 *
 * It has to be the binding and not global `fetch`: that is the whole point of `lib/jwks.ts` reading
 * the key set over a binding, and a suite that stubbed `fetch` is exactly why the 522 the public
 * URL returns in production went unnoticed.
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
 * Replaces the `AUTH` service binding — the only channel `lib/jwks.ts` reads the key set through —
 * with `handler`. Returned so a test can assert on how many times the Worker actually asked.
 */
const stubJwksFetch = (handler: (url: string, init?: RequestInit) => Promise<Response>) => {
  const fetchMock = vi.fn(handler)
  ;(env as { AUTH: Fetcher }).AUTH = { fetch: fetchMock } as unknown as Fetcher
  return fetchMock
}

/** The common case: a binding that serves `keys` and never fails. */
const stubJwks = (keys: Jwk[]) => stubJwksFetch(async () => Response.json({ keys }))

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
  stubJwksFetch,
  testKeyPair,
}
export type { Jwk, KeyPair }
