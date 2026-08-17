import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { applications, authorizationRequests } from '@/db/schema'
import { TTL } from '@/lib/config'
import { sha256 } from '@/lib/crypto'
import { RedirectValidationException } from '@/lib/errors'
import { getApplication } from '@/services/applications'
import type { Application } from '@/services/applications'
import {
  createAuthorizationRequest,
  loadAuthorizationRequest,
  toAuthorizationRequest,
} from '@/services/authorization-requests'
import { createApplication, db, SEED } from '../helpers/db'
import { RFC7636 } from '../helpers/pkce'

const park = async (overrides: Partial<Parameters<typeof createAuthorizationRequest>[1]> = {}) => {
  const application = overrides.application ?? ((await getApplication(db(), SEED.webAppId)) as Application)
  return createAuthorizationRequest(db(), {
    application,
    redirectUri: SEED.webRedirectUri,
    state: 'client-state',
    nonce: 'n-once',
    codeChallenge: RFC7636.challenge,
    codeChallengeMethod: 'S256',
    scope: 'openid profile email',
    prompt: null,
    loginHint: null,
    ip: null,
    userAgent: null,
    ...overrides,
  })
}

describe('createAuthorizationRequest', () => {
  it('returns an opaque handle and stores only its hash', async () => {
    const { handle, record } = await park()

    expect(handle).toMatch(/^[A-Za-z0-9\-_]{43}$/)
    expect(record.handleHash).toBe(await sha256(handle))
    expect(record.handleHash).not.toBe(handle)
  })

  it('freezes every parameter the client asked for', async () => {
    const { record } = await park({ loginHint: 'ada@example.test', prompt: 'login', scope: 'openid' })

    expect(record).toMatchObject({
      applicationId: SEED.webAppId,
      redirectUri: SEED.webRedirectUri,
      state: 'client-state',
      nonce: 'n-once',
      codeChallenge: RFC7636.challenge,
      codeChallengeMethod: 'S256',
      scope: 'openid',
      prompt: 'login',
      loginHint: 'ada@example.test',
    })
  })

  it('gives the request a deadline', async () => {
    const { record } = await park()

    expect(record.expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(record.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + TTL.authorizationRequest * 1000)
  })

  it('mints a different handle every time', async () => {
    const first = await park()
    const second = await park()

    expect(first.handle).not.toBe(second.handle)
  })

  it('accepts a request with no PKCE challenge, for a client that opted out', async () => {
    const application = await createApplication({
      clientSecret: `no-pkce-${crypto.randomUUID()}`,
      requirePkce: false,
    })
    const { record } = await park({ application, codeChallenge: null, codeChallengeMethod: null })

    expect(record.codeChallenge).toBeNull()
  })
})

describe('loadAuthorizationRequest', () => {
  it('resolves a handle back into the request and its client', async () => {
    const { handle } = await park()

    const loaded = await loadAuthorizationRequest(db(), handle)

    expect(loaded.record.state).toBe('client-state')
    expect(loaded.application.id).toBe(SEED.webAppId)
  })

  it('can be resolved more than once, so a user may pick a different provider', async () => {
    const { handle } = await park()

    await expect(loadAuthorizationRequest(db(), handle)).resolves.toBeTruthy()
    await expect(loadAuthorizationRequest(db(), handle)).resolves.toBeTruthy()
  })

  it('refuses an unknown handle as a rendered failure, never as a redirect', async () => {
    await expect(loadAuthorizationRequest(db(), 'not-a-handle')).rejects.toThrow(RedirectValidationException)
    await expect(loadAuthorizationRequest(db(), 'not-a-handle')).rejects.toMatchObject({ status: 400 })
  })

  it('refuses an expired one', async () => {
    const { handle, record } = await park()
    await db()
      .update(authorizationRequests)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authorizationRequests.id, record.id))

    await expect(loadAuthorizationRequest(db(), handle)).rejects.toThrow('This sign-in request expired')
  })

  it('re-reads the client, so deactivating one stops a sign-in already in flight', async () => {
    const application = await createApplication({ redirectUris: ['https://midflight.test/cb'] })
    const { handle } = await park({ application, redirectUri: 'https://midflight.test/cb' })

    await db().update(applications).set({ isActive: false }).where(eq(applications.id, application.id))

    await expect(loadAuthorizationRequest(db(), handle)).rejects.toThrow(
      'The application this sign-in was started for is no longer available',
    )
  })
})

describe('toAuthorizationRequest', () => {
  it('rebuilds exactly the shape the provider layer consumes', async () => {
    const { record } = await park()
    const application = (await getApplication(db(), SEED.webAppId)) as Application

    expect(toAuthorizationRequest(record, application)).toEqual({
      application,
      redirectUri: SEED.webRedirectUri,
      state: 'client-state',
      nonce: 'n-once',
      codeChallenge: RFC7636.challenge,
      codeChallengeMethod: 'S256',
      scope: 'openid profile email',
    })
  })

  it('turns a null scope into the empty string the request type expects', async () => {
    const { record } = await park({ scope: '' })
    const application = (await getApplication(db(), SEED.webAppId)) as Application

    expect(toAuthorizationRequest({ ...record, scope: null }, application).scope).toBe('')
  })
})
