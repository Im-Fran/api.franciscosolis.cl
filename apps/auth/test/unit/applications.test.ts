import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { applications } from '@/db/schema'
import { sha256 } from '@/lib/crypto'
import { OAuthException, RedirectValidationException } from '@/lib/errors'
import {
  assertGrantAllowed,
  authenticateClient,
  DEFAULT_SCOPE,
  getApplication,
  getRedirectUris,
  isConfidential,
  issueSecret,
  listSecrets,
  normalizeScope,
  readClientCredentials,
  resolveClient,
  retireOtherSecrets,
  revokeSecret,
  validatePkceParameters,
} from '@/services/applications'
import type { Application } from '@/services/applications'
import { createApplication, createSecret, db, SEED } from '../helpers/db'
import { RFC7636 } from '../helpers/pkce'

const application = (overrides: Partial<Application> = {}): Application => ({
  id: 'client',
  name: 'Client',
  description: null,
  tokenEndpointAuthMethod: 'none',
  redirectUris: '[]',
  postLogoutRedirectUris: '[]',
  grantTypes: '["authorization_code","refresh_token"]',
  scopes: '[]',
  requirePkce: true,
  allowedOrigins: '[]',
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

/** A confidential client, in the envelope the token endpoint will hold it to. */
const confidentialApplication = (overrides: Partial<Application> = {}): Application =>
  application({ tokenEndpointAuthMethod: 'client_secret_post', ...overrides })

const basicHeader = (clientId: string, clientSecret: string) =>
  `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`

describe('getApplication', () => {
  it('returns a seeded, active client', async () => {
    const found = await getApplication(db(), SEED.webAppId)

    expect(found?.id).toBe(SEED.webAppId)
    expect(found?.tokenEndpointAuthMethod).toBe('none')
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
    expect(validatePkceParameters(application(), RFC7636.challenge, undefined)).toEqual({
      codeChallenge: RFC7636.challenge,
      codeChallengeMethod: 'S256',
    })
  })

  it('accepts an explicit S256', () => {
    expect(validatePkceParameters(application(), RFC7636.challenge, 'S256').codeChallengeMethod).toBe('S256')
  })

  it('rejects plain and any other method', () => {
    for (const method of ['plain', 's256', 'S512', '']) {
      expect(() => validatePkceParameters(application(), RFC7636.challenge, method)).toThrow(
        new OAuthException(400, 'invalid_request', 'code_challenge_method must be S256'),
      )
    }
  })

  it('requires a challenge exactly 43 characters long, the size of a base64url SHA-256', () => {
    expect(() => validatePkceParameters(application(), 'a'.repeat(42), 'S256')).toThrow(/base64url-encoded SHA-256 digest/)
    expect(() => validatePkceParameters(application(), 'a'.repeat(44), 'S256')).toThrow(/base64url-encoded SHA-256 digest/)
    expect(validatePkceParameters(application(), 'a'.repeat(43), 'S256').codeChallenge).toBe('a'.repeat(43))
  })

  it('rejects a challenge in standard base64 rather than base64url', () => {
    for (const challenge of [`${'a'.repeat(42)}+`, `${'a'.repeat(42)}/`, `${'a'.repeat(42)}=`]) {
      expect(() => validatePkceParameters(application(), challenge, 'S256')).toThrow(OAuthException)
    }
  })

  it('rejects an empty challenge', () => {
    expect(() => validatePkceParameters(application(), '', 'S256')).toThrow(OAuthException)
  })

  it('reports both failures as invalid_request', () => {
    expect(() => validatePkceParameters(application(), RFC7636.challenge, 'plain')).toThrow(
      expect.objectContaining({ code: 'invalid_request', status: 400 }),
    )
    expect(() => validatePkceParameters(application(), 'short', 'S256')).toThrow(
      expect.objectContaining({ code: 'invalid_request', status: 400 }),
    )
  })
})


describe('validatePkceParameters without a challenge', () => {
  it('refuses a public client that sends none, whatever require_pkce says', () => {
    expect(() => validatePkceParameters(application(), undefined, undefined)).toThrow(
      new OAuthException(400, 'invalid_request', 'code_challenge is required for this client'),
    )
    expect(() => validatePkceParameters(application({ requirePkce: false }), undefined, undefined)).toThrow(
      'code_challenge is required for this client',
    )
  })

  it('refuses a confidential client that still requires PKCE', () => {
    expect(() => validatePkceParameters(confidentialApplication(), undefined, undefined)).toThrow(OAuthException)
  })

  it('lets a confidential client opt out, which is the only way PKCE is ever skipped', () => {
    expect(
      validatePkceParameters(confidentialApplication({ requirePkce: false }), undefined, undefined),
    ).toEqual({ codeChallenge: null, codeChallengeMethod: null })
  })

  it('refuses a method sent without a challenge, which is always a client bug', () => {
    expect(() => validatePkceParameters(confidentialApplication({ requirePkce: false }), undefined, 'S256')).toThrow(
      'code_challenge_method was sent without a code_challenge',
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

  it('accepts the OIDC scopes this server implements', () => {
    expect(normalizeScope('openid offline_access')).toBe('openid offline_access')
    expect(normalizeScope('openid roles groups')).toBe('openid roles groups')
  })

  it('rejects an unsupported scope and names it', () => {
    expect(() => normalizeScope('openid drive.readonly')).toThrow(
      new OAuthException(400, 'invalid_scope', 'Unsupported scope: drive.readonly'),
    )
  })

  it('names every unsupported scope, not just the first', () => {
    expect(() => normalizeScope('openid admin write')).toThrow('Unsupported scope: admin, write')
  })

  it('is case-sensitive, so OPENID is not silently accepted', () => {
    expect(() => normalizeScope('OPENID')).toThrow(OAuthException)
  })

  it('narrows to what the client is allowed, and names what it may not ask for', () => {
    const narrowed = application({ scopes: '["openid","email"]' })

    expect(normalizeScope('openid email', narrowed)).toBe('openid email')
    expect(() => normalizeScope('openid profile', narrowed)).toThrow(
      new OAuthException(400, 'invalid_scope', 'This client may not request: profile'),
    )
  })

  it('trims the default down to the allowed set rather than handing out a refused scope', () => {
    expect(normalizeScope(undefined, application({ scopes: '["openid","email"]' }))).toBe('openid email')
  })

  it('treats an empty allowlist as "every supported scope"', () => {
    expect(normalizeScope('openid groups', application({ scopes: '[]' }))).toBe('openid groups')
  })

  it('deduplicates a repeated scope', () => {
    expect(normalizeScope('openid openid email')).toBe('openid email')
  })
})

describe('assertGrantAllowed', () => {
  it('accepts a grant the client is registered for', () => {
    expect(() => assertGrantAllowed(application(), 'authorization_code')).not.toThrow()
    expect(() => assertGrantAllowed(application(), 'refresh_token')).not.toThrow()
  })

  it('refuses one it is not, as unauthorized_client', () => {
    expect(() => assertGrantAllowed(application(), 'client_credentials')).toThrow(
      expect.objectContaining({ code: 'unauthorized_client', status: 400 }),
    )
  })

  it('reads the stored list, so a client can be restricted to a single grant', () => {
    const machine = application({ grantTypes: '["client_credentials"]' })

    expect(() => assertGrantAllowed(machine, 'client_credentials')).not.toThrow()
    expect(() => assertGrantAllowed(machine, 'authorization_code')).toThrow(OAuthException)
  })

  it('ignores a grant type this server does not implement, rather than trusting the row', () => {
    expect(() => assertGrantAllowed(application({ grantTypes: '["password"]' }), 'authorization_code')).toThrow(
      OAuthException,
    )
  })
})

describe('readClientCredentials', () => {
  it('reads client_secret_post from the body', () => {
    expect(readClientCredentials(undefined, { client_id: 'a', client_secret: 's' })).toEqual({
      clientId: 'a',
      clientSecret: 's',
      method: 'client_secret_post',
    })
  })

  it('reads a public client, which sends no secret at all', () => {
    expect(readClientCredentials(undefined, { client_id: 'a' })).toEqual({
      clientId: 'a',
      clientSecret: null,
      method: 'none',
    })
  })

  it('reads client_secret_basic from the Authorization header', () => {
    expect(readClientCredentials(basicHeader('a', 's'), {})).toEqual({
      clientId: 'a',
      clientSecret: 's',
      method: 'client_secret_basic',
    })
  })

  it('percent-decodes both halves, as RFC 6749 §2.3.1 requires', () => {
    expect(readClientCredentials(basicHeader('a', 'p@ss:word/+='), {}).clientSecret).toBe('p@ss:word/+=')
  })

  it('splits on the first colon, so a secret may contain one', () => {
    expect(readClientCredentials(`Basic ${btoa('a:b:c')}`, {}).clientSecret).toBe('b:c')
  })

  it('takes a secret that was never percent-encoded as it stands', () => {
    expect(readClientCredentials(`Basic ${btoa('a:100%pure')}`, {}).clientSecret).toBe('100%pure')
  })

  it('refuses credentials sent in both envelopes at once', () => {
    expect(() => readClientCredentials(basicHeader('a', 's'), { client_id: 'a', client_secret: 's' })).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    )
  })

  it('refuses a body client_id that contradicts the header', () => {
    expect(() => readClientCredentials(basicHeader('a', 's'), { client_id: 'b' })).toThrow(
      'client_id in the body does not match the Authorization header',
    )
  })

  it('accepts a body client_id that agrees with the header', () => {
    expect(readClientCredentials(basicHeader('a', 's'), { client_id: 'a' }).clientId).toBe('a')
  })

  it('requires a client_id when there is no Basic header', () => {
    expect(() => readClientCredentials(undefined, {})).toThrow('client_id is required')
  })

  it('ignores a non-Basic Authorization header and falls back to the body', () => {
    expect(readClientCredentials('Bearer abc', { client_id: 'a' }).method).toBe('none')
  })

  it('refuses a Basic header with no colon in it', () => {
    expect(() => readClientCredentials(`Basic ${btoa('nocolon')}`, {})).toThrow(
      expect.objectContaining({ code: 'invalid_client' }),
    )
  })

  it('refuses a Basic header that is not base64', () => {
    expect(() => readClientCredentials('Basic !!!not base64!!!', {})).toThrow(
      expect.objectContaining({ code: 'invalid_client' }),
    )
  })
})

describe('authenticateClient', () => {
  it('lets a public client through on PKCE alone', async () => {
    await expect(authenticateClient(db(), application(), { clientSecret: null, method: 'none' })).resolves.toBeNull()
  })

  it('refuses a secret sent by a public client, which cannot have one', async () => {
    await expect(
      authenticateClient(db(), application(), { clientSecret: 'anything', method: 'client_secret_post' }),
    ).rejects.toThrow(new OAuthException(401, 'invalid_client', 'This client is public and must not send a client_secret'))
  })

  it('requires the secret from a confidential client', async () => {
    const created = await createApplication({ clientSecret: 'needed-secret' })

    await expect(
      authenticateClient(db(), created, { clientSecret: null, method: 'none' }),
    ).rejects.toThrow('client_secret is required for this client')
  })

  it('accepts the right secret and refuses a wrong one', async () => {
    const created = await createApplication({ clientSecret: 'right-secret' })

    await expect(
      authenticateClient(db(), created, { clientSecret: 'right-secret', method: 'client_secret_post' }),
    ).resolves.toMatchObject({ applicationId: created.id })
    await expect(
      authenticateClient(db(), created, { clientSecret: 'right-secrez', method: 'client_secret_post' }),
    ).rejects.toThrow('Invalid client credentials')
    await expect(
      authenticateClient(db(), created, { clientSecret: 'right-secret ', method: 'client_secret_post' }),
    ).rejects.toThrow('Invalid client credentials')
  })

  it('holds the client to the envelope it registered', async () => {
    const created = await createApplication({ clientSecret: 'basic-only', tokenEndpointAuthMethod: 'client_secret_basic' })

    await expect(
      authenticateClient(db(), created, { clientSecret: 'basic-only', method: 'client_secret_basic' }),
    ).resolves.not.toBeNull()
    await expect(
      authenticateClient(db(), created, { clientSecret: 'basic-only', method: 'client_secret_post' }),
    ).rejects.toThrow('This client must authenticate with client_secret_basic')
  })

  it('compares the hash, so a stored hash is not itself a usable secret', async () => {
    const created = await createApplication({ clientSecret: 'hash-me' })
    const [stored] = await listSecrets(db(), created.id)

    await expect(
      authenticateClient(db(), created, { clientSecret: stored.secretHash, method: 'client_secret_post' }),
    ).rejects.toThrow('Invalid client credentials')
  })

  it('accepts any secret currently alive, which is what makes a rotation overlap', async () => {
    const created = await createApplication({ clientSecret: 'old-one' })
    await createSecret(created.id, 'new-one')

    for (const secret of ['old-one', 'new-one']) {
      await expect(
        authenticateClient(db(), created, { clientSecret: secret, method: 'client_secret_post' }),
      ).resolves.not.toBeNull()
    }
  })

  it('refuses a revoked secret and an expired one', async () => {
    const created = await createApplication({ clientSecret: 'live' })
    await createSecret(created.id, 'revoked', { revokedAt: new Date() })
    await createSecret(created.id, 'expired', { expiresAt: new Date(Date.now() - 1000) })

    for (const secret of ['revoked', 'expired']) {
      await expect(
        authenticateClient(db(), created, { clientSecret: secret, method: 'client_secret_post' }),
      ).rejects.toThrow('Invalid client credentials')
    }
    await expect(
      authenticateClient(db(), created, { clientSecret: 'live', method: 'client_secret_post' }),
    ).resolves.not.toBeNull()
  })

  it('accepts a secret whose grace period has not run out yet', async () => {
    const created = await createApplication({ tokenEndpointAuthMethod: 'client_secret_post' })
    await createSecret(created.id, 'still-in-grace', { expiresAt: new Date(Date.now() + 60_000) })

    await expect(
      authenticateClient(db(), created, { clientSecret: 'still-in-grace', method: 'client_secret_post' }),
    ).resolves.not.toBeNull()
  })

  it('stamps last_used_at on the secret that matched, so a stale one can be spotted', async () => {
    const created = await createApplication({ clientSecret: 'used-secret' })
    const unused = await createSecret(created.id, 'never-used')

    await authenticateClient(db(), created, { clientSecret: 'used-secret', method: 'client_secret_post' })

    const stored = await listSecrets(db(), created.id)
    expect(stored.find((row) => row.hint === 'used-s')?.lastUsedAt).not.toBeNull()
    expect(stored.find((row) => row.id === unused.id)?.lastUsedAt).toBeNull()
  })

  it('answers 401 invalid_client for every credential failure', async () => {
    const created = await createApplication({ clientSecret: 'the-right-one' })

    await expect(
      authenticateClient(db(), application(), { clientSecret: 'x', method: 'client_secret_post' }),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_client' })
    await expect(
      authenticateClient(db(), created, { clientSecret: 'wrong', method: 'client_secret_post' }),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_client' })
  })
})

describe('isConfidential', () => {
  it('is decided by the authentication method, not by whether a secret happens to exist', () => {
    expect(isConfidential(application())).toBe(false)
    expect(isConfidential(application({ tokenEndpointAuthMethod: 'client_secret_post' }))).toBe(true)
    expect(isConfidential(application({ tokenEndpointAuthMethod: 'client_secret_basic' }))).toBe(true)
  })

  it('treats an unrecognised method as public, the safer of the two readings', () => {
    expect(isConfidential(application({ tokenEndpointAuthMethod: 'private_key_jwt' }))).toBe(false)
  })
})

describe('issueSecret', () => {
  it('returns the plaintext once and stores only its hash', async () => {
    const created = await createApplication({ tokenEndpointAuthMethod: 'client_secret_post' })
    const { secret, record } = await issueSecret(db(), { applicationId: created.id })

    expect(secret).toMatch(/^[A-Za-z0-9\-_]{43}$/)
    expect(record.secretHash).not.toBe(secret)
    expect(record.secretHash).toBe(await sha256(secret))
  })

  it('keeps a short hint so two secrets can be told apart in a list', async () => {
    const created = await createApplication({ tokenEndpointAuthMethod: 'client_secret_post' })
    const { secret, record } = await issueSecret(db(), { applicationId: created.id })

    expect(record.hint).toBe(secret.slice(0, 6))
    expect(secret.startsWith(record.hint)).toBe(true)
    expect(record.hint.length).toBeLessThan(secret.length)
  })

  it('never expires unless asked to', async () => {
    const created = await createApplication({ tokenEndpointAuthMethod: 'client_secret_post' })

    expect((await issueSecret(db(), { applicationId: created.id })).record.expiresAt).toBeNull()
    expect(
      (await issueSecret(db(), { applicationId: created.id, expiresIn: 3600 })).record.expiresAt,
    ).toBeInstanceOf(Date)
  })

  it('mints a different secret every time', async () => {
    const created = await createApplication({ tokenEndpointAuthMethod: 'client_secret_post' })
    const first = await issueSecret(db(), { applicationId: created.id })
    const second = await issueSecret(db(), { applicationId: created.id })

    expect(first.secret).not.toBe(second.secret)
  })
})

describe('retireOtherSecrets', () => {
  it('gives the outgoing secrets a deadline instead of killing them', async () => {
    const created = await createApplication({ clientSecret: 'outgoing-graced' })
    const { record } = await issueSecret(db(), { applicationId: created.id })

    expect(await retireOtherSecrets(db(), created.id, record.id, 3600)).toBe(1)

    const stored = await listSecrets(db(), created.id)
    const outgoing = stored.find((row) => row.id !== record.id)!
    expect(outgoing.revokedAt).toBeNull()
    expect(outgoing.expiresAt!.getTime()).toBeGreaterThan(Date.now())
    await expect(
      authenticateClient(db(), created, { clientSecret: 'outgoing-graced', method: 'client_secret_post' }),
    ).resolves.not.toBeNull()
  })

  it('revokes them outright with no grace, which is what a leak calls for', async () => {
    const created = await createApplication({ clientSecret: 'leaked' })
    const { record } = await issueSecret(db(), { applicationId: created.id })

    await retireOtherSecrets(db(), created.id, record.id, 0)

    await expect(
      authenticateClient(db(), created, { clientSecret: 'leaked', method: 'client_secret_post' }),
    ).rejects.toThrow('Invalid client credentials')
  })

  it('leaves the secret being kept alone', async () => {
    const created = await createApplication({ clientSecret: 'outgoing-cut' })
    const { secret, record } = await issueSecret(db(), { applicationId: created.id })

    await retireOtherSecrets(db(), created.id, record.id, 0)

    await expect(
      authenticateClient(db(), created, { clientSecret: secret, method: 'client_secret_post' }),
    ).resolves.not.toBeNull()
  })

  it('never postpones an expiry that was already closer than the grace period', async () => {
    const created = await createApplication({ tokenEndpointAuthMethod: 'client_secret_post' })
    const soon = new Date(Date.now() + 60_000)
    await createSecret(created.id, 'ending-soon', { expiresAt: soon })
    const { record } = await issueSecret(db(), { applicationId: created.id })

    await retireOtherSecrets(db(), created.id, record.id, 86_400)

    // D1 stores timestamps as whole unix seconds, so the fixture is compared at that resolution.
    const stored = await listSecrets(db(), created.id)
    expect(stored.find((row) => row.id !== record.id)?.expiresAt?.getTime()).toBe(
      Math.floor(soon.getTime() / 1000) * 1000,
    )
  })

  it('reports how many it retired, and does nothing when there is nothing to retire', async () => {
    const created = await createApplication({ tokenEndpointAuthMethod: 'client_secret_post' })
    const { record } = await issueSecret(db(), { applicationId: created.id })

    expect(await retireOtherSecrets(db(), created.id, record.id, 3600)).toBe(0)
  })

  it('does not touch another application\'s secrets', async () => {
    const mine = await createApplication({ clientSecret: 'mine' })
    const theirs = await createApplication({ clientSecret: 'theirs' })
    const { record } = await issueSecret(db(), { applicationId: mine.id })

    await retireOtherSecrets(db(), mine.id, record.id, 0)

    await expect(
      authenticateClient(db(), theirs, { clientSecret: 'theirs', method: 'client_secret_post' }),
    ).resolves.not.toBeNull()
  })
})

describe('revokeSecret', () => {
  it('takes the secret out of use immediately', async () => {
    const created = await createApplication({ clientSecret: 'doomed' })
    const [stored] = await listSecrets(db(), created.id)

    await revokeSecret(db(), stored.id)

    await expect(
      authenticateClient(db(), created, { clientSecret: 'doomed', method: 'client_secret_post' }),
    ).rejects.toThrow('Invalid client credentials')
  })
})
