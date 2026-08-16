import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { applications } from '@/db/schema'
import { sha256 } from '@/lib/crypto'
import { OAuthException, RedirectValidationException } from '@/lib/errors'
import {
  authenticateClient,
  DEFAULT_SCOPE,
  getApplication,
  getRedirectUris,
  normalizeScope,
  resolveClient,
  validatePkceParameters,
} from '@/services/applications'
import type { Application } from '@/services/applications'
import { createApplication, db, SEED } from '../helpers/db'
import { RFC7636 } from '../helpers/pkce'

const application = (overrides: Partial<Application> = {}): Application => ({
  id: 'client',
  name: 'Client',
  description: null,
  clientSecretHash: null,
  redirectUris: '[]',
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

describe('getApplication', () => {
  it('returns a seeded, active client', async () => {
    const found = await getApplication(db(), SEED.webAppId)

    expect(found?.id).toBe(SEED.webAppId)
    expect(found?.clientSecretHash).toBeNull()
  })

  it('returns null for an unknown client id', async () => {
    await expect(getApplication(db(), 'nope')).resolves.toBeNull()
  })

  it('hides a deactivated client, so deactivating stops new sign-ins immediately', async () => {
    const created = await createApplication({ isActive: false })

    await expect(getApplication(db(), created.id)).resolves.toBeNull()

    await db().update(applications).set({ isActive: true }).where(eq(applications.id, created.id))
    await expect(getApplication(db(), created.id)).resolves.not.toBeNull()
  })

  it('does not match a client id by prefix or by case', async () => {
    await expect(getApplication(db(), SEED.webAppId.toUpperCase())).resolves.toBeNull()
    await expect(getApplication(db(), 'franciscosolis')).resolves.toBeNull()
  })
})

describe('getRedirectUris', () => {
  it('parses the stored JSON array', () => {
    expect(getRedirectUris(application({ redirectUris: '["https://a.test/cb","https://b.test/cb"]' }))).toEqual([
      'https://a.test/cb',
      'https://b.test/cb',
    ])
  })

  it('returns an empty list rather than throwing on malformed JSON', () => {
    expect(getRedirectUris(application({ redirectUris: 'not json' }))).toEqual([])
  })

  it('returns an empty list when the JSON is not an array', () => {
    expect(getRedirectUris(application({ redirectUris: '{"a":1}' }))).toEqual([])
    expect(getRedirectUris(application({ redirectUris: 'null' }))).toEqual([])
  })

  it('drops entries that are not strings, which could never match anyway', () => {
    expect(getRedirectUris(application({ redirectUris: '["https://a.test/cb", 42, null, {}]' }))).toEqual([
      'https://a.test/cb',
    ])
  })
})

describe('resolveClient', () => {
  it('returns the application and the redirect URI on an exact match', async () => {
    const resolved = await resolveClient(db(), SEED.webAppId, SEED.webRedirectUri)

    expect(resolved.application.id).toBe(SEED.webAppId)
    expect(resolved.redirectUri).toBe(SEED.webRedirectUri)
  })

  it('accepts any of the registered URIs, not only the first', async () => {
    await expect(resolveClient(db(), SEED.webAppId, SEED.webLocalRedirectUri)).resolves.toMatchObject({
      redirectUri: SEED.webLocalRedirectUri,
    })
  })

  it('refuses an unknown client before it ever looks at the redirect URI', async () => {
    await expect(resolveClient(db(), 'ghost', SEED.webRedirectUri)).rejects.toThrow(
      new RedirectValidationException('Unknown or inactive client_id'),
    )
  })

  it('refuses a redirect URI registered for a different client', async () => {
    await expect(resolveClient(db(), SEED.webAppId, SEED.cmsRedirectUri)).rejects.toThrow(
      'redirect_uri is not registered for this client',
    )
  })

  it('matches exactly: a trailing slash, extra path or added query is a different URI', async () => {
    for (const uri of [
      `${SEED.webRedirectUri}/`,
      `${SEED.webRedirectUri}?next=/`,
      `${SEED.webRedirectUri}/../evil`,
      'https://franciscosolis.cl/auth/callback2',
      'https://evil.test/auth/callback',
      SEED.webRedirectUri.toUpperCase(),
    ]) {
      await expect(resolveClient(db(), SEED.webAppId, uri)).rejects.toBeInstanceOf(RedirectValidationException)
    }
  })

  it('reports the failure as a 400 rendered to the user, never as a redirect', async () => {
    await expect(resolveClient(db(), 'ghost', SEED.webRedirectUri)).rejects.toMatchObject({ status: 400 })
  })
})

describe('validatePkceParameters', () => {
  it('defaults the method to S256 when the client omits it', () => {
    expect(validatePkceParameters(RFC7636.challenge, undefined)).toEqual({
      codeChallenge: RFC7636.challenge,
      codeChallengeMethod: 'S256',
    })
  })

  it('accepts an explicit S256', () => {
    expect(validatePkceParameters(RFC7636.challenge, 'S256').codeChallengeMethod).toBe('S256')
  })

  it('rejects plain and any other method', () => {
    for (const method of ['plain', 's256', 'S512', '']) {
      expect(() => validatePkceParameters(RFC7636.challenge, method)).toThrow(
        new OAuthException(400, 'invalid_request', 'code_challenge_method must be S256'),
      )
    }
  })

  it('requires a challenge exactly 43 characters long, the size of a base64url SHA-256', () => {
    expect(() => validatePkceParameters('a'.repeat(42), 'S256')).toThrow(/base64url-encoded SHA-256 digest/)
    expect(() => validatePkceParameters('a'.repeat(44), 'S256')).toThrow(/base64url-encoded SHA-256 digest/)
    expect(validatePkceParameters('a'.repeat(43), 'S256').codeChallenge).toBe('a'.repeat(43))
  })

  it('rejects a challenge in standard base64 rather than base64url', () => {
    for (const challenge of [`${'a'.repeat(42)}+`, `${'a'.repeat(42)}/`, `${'a'.repeat(42)}=`]) {
      expect(() => validatePkceParameters(challenge, 'S256')).toThrow(OAuthException)
    }
  })

  it('rejects an empty challenge', () => {
    expect(() => validatePkceParameters('', 'S256')).toThrow(OAuthException)
  })

  it('reports both failures as invalid_request', () => {
    expect(() => validatePkceParameters(RFC7636.challenge, 'plain')).toThrow(
      expect.objectContaining({ code: 'invalid_request', status: 400 }),
    )
    expect(() => validatePkceParameters('short', 'S256')).toThrow(
      expect.objectContaining({ code: 'invalid_request', status: 400 }),
    )
  })
})

describe('normalizeScope', () => {
  it('falls back to the full default when no scope is requested', () => {
    expect(normalizeScope(undefined)).toBe(DEFAULT_SCOPE)
    expect(normalizeScope(null)).toBe(DEFAULT_SCOPE)
    expect(normalizeScope('')).toBe(DEFAULT_SCOPE)
    expect(DEFAULT_SCOPE).toBe('openid profile email')
  })

  it('keeps a narrower request as requested rather than widening it', () => {
    expect(normalizeScope('openid')).toBe('openid')
    expect(normalizeScope('email openid')).toBe('email openid')
  })

  it('collapses arbitrary whitespace between entries', () => {
    expect(normalizeScope('  openid \t profile\nemail  ')).toBe('openid profile email')
  })

  it('rejects an unsupported scope and names it', () => {
    expect(() => normalizeScope('openid offline_access')).toThrow(
      new OAuthException(400, 'invalid_scope', 'Unsupported scope: offline_access'),
    )
  })

  it('names every unsupported scope, not just the first', () => {
    expect(() => normalizeScope('openid admin write')).toThrow('Unsupported scope: admin, write')
  })

  it('is case-sensitive, so OPENID is not silently accepted', () => {
    expect(() => normalizeScope('OPENID')).toThrow(OAuthException)
  })
})

describe('authenticateClient', () => {
  it('lets a public client through on PKCE alone', async () => {
    await expect(authenticateClient(application(), undefined)).resolves.toBeUndefined()
  })

  it('refuses a secret sent by a public client, which cannot have one', async () => {
    await expect(authenticateClient(application(), 'anything')).rejects.toThrow(
      new OAuthException(401, 'invalid_client', 'This client is public and must not send a client_secret'),
    )
  })

  it('requires the secret from a confidential client', async () => {
    const confidential = application({ clientSecretHash: await sha256('s3cret') })

    await expect(authenticateClient(confidential, undefined)).rejects.toThrow('client_secret is required for this client')
    await expect(authenticateClient(confidential, '')).rejects.toThrow('client_secret is required for this client')
  })

  it('accepts the right secret and refuses a wrong one', async () => {
    const confidential = application({ clientSecretHash: await sha256('s3cret') })

    await expect(authenticateClient(confidential, 's3cret')).resolves.toBeUndefined()
    await expect(authenticateClient(confidential, 's3cres')).rejects.toThrow('Invalid client credentials')
    await expect(authenticateClient(confidential, 's3cret ')).rejects.toThrow('Invalid client credentials')
  })

  it('compares the hash, so a stored hash is not itself a usable secret', async () => {
    const hash = await sha256('s3cret')

    await expect(authenticateClient(application({ clientSecretHash: hash }), hash)).rejects.toThrow(
      'Invalid client credentials',
    )
  })

  it('answers 401 invalid_client for every credential failure', async () => {
    await expect(authenticateClient(application(), 'x')).rejects.toMatchObject({ status: 401, code: 'invalid_client' })
    await expect(
      authenticateClient(application({ clientSecretHash: await sha256('a') }), 'b'),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_client' })
  })
})
