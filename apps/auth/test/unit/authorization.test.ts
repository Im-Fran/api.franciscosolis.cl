import { desc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { auditLogs } from '@/db/schema'
import type { Application } from '@/services/applications'
import { getApplication } from '@/services/applications'
import { completeAuthentication } from '@/services/authorization'
import { consumeAuthorizationCode } from '@/services/tokens'
import type { AuthorizationRequest, ProviderProfile } from '@/providers/types'
import { createInvitation, createUser, db, SEED, uniqueEmail } from '../helpers/db'
import { RFC7636 } from '../helpers/pkce'

const authorizationRequest = async (overrides: Partial<AuthorizationRequest> = {}): Promise<AuthorizationRequest> => ({
  application: (await getApplication(db(), SEED.webAppId)) as Application,
  redirectUri: SEED.webRedirectUri,
  state: 'client-state',
  codeChallenge: RFC7636.challenge,
  codeChallengeMethod: 'S256',
  scope: 'openid profile email',
  ...overrides,
})

const profileFor = (email: string): ProviderProfile => ({
  provider: 'magic_link',
  providerAccountId: email,
  email,
  emailVerified: true,
})

const latestAudit = async (userId: string) => {
  const [row] = await db()
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.userId, userId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(1)
  return row ?? null
}

describe('completeAuthentication', () => {
  it('sends the browser back to the client with a code and the echoed state', async () => {
    const user = await createUser({ email: uniqueEmail('complete') })

    const result = await completeAuthentication(db(), {
      request: await authorizationRequest(),
      profile: profileFor(user.email),
      ip: null,
      userAgent: null,
    })

    const url = new URL(result.redirectUrl)
    expect(url.origin + url.pathname).toBe(SEED.webRedirectUri)
    expect(url.searchParams.get('state')).toBe('client-state')
    expect(url.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(result.user.id).toBe(user.id)
    expect(result.isNewUser).toBe(false)
  })

  it('omits state when the client did not send one', async () => {
    const user = await createUser({ email: uniqueEmail('nostate') })

    const result = await completeAuthentication(db(), {
      request: await authorizationRequest({ state: null }),
      profile: profileFor(user.email),
      ip: null,
      userAgent: null,
    })

    expect(new URL(result.redirectUrl).searchParams.has('state')).toBe(false)
  })

  it('binds the issued code to the application, redirect URI and PKCE challenge of the request', async () => {
    const user = await createUser({ email: uniqueEmail('bind') })

    const result = await completeAuthentication(db(), {
      request: await authorizationRequest({ redirectUri: SEED.webLocalRedirectUri, scope: 'openid' }),
      profile: profileFor(user.email),
      ip: null,
      userAgent: null,
    })

    const code = new URL(result.redirectUrl).searchParams.get('code') as string
    await expect(consumeAuthorizationCode(db(), code)).resolves.toMatchObject({
      userId: user.id,
      applicationId: SEED.webAppId,
      provider: 'magic_link',
      redirectUri: SEED.webLocalRedirectUri,
      codeChallenge: RFC7636.challenge,
      codeChallengeMethod: 'S256',
      scope: 'openid',
    })
  })

  it('records a sign-in as oauth.callback.succeeded and a sign-up as user.created', async () => {
    const returning = await createUser({ email: uniqueEmail('returning') })
    await completeAuthentication(db(), {
      request: await authorizationRequest(),
      profile: profileFor(returning.email),
      ip: '203.0.113.1',
      userAgent: 'probe/4.0',
    })

    const signIn = await latestAudit(returning.id)
    expect(signIn).toMatchObject({ event: 'oauth.callback.succeeded', ip: '203.0.113.1', userAgent: 'probe/4.0' })
    expect(JSON.parse(signIn?.metadata ?? 'null')).toEqual({ provider: 'magic_link' })

    const email = uniqueEmail('brand-new')
    await createInvitation({ email })
    const created = await completeAuthentication(db(), {
      request: await authorizationRequest(),
      profile: profileFor(email),
      ip: null,
      userAgent: null,
    })

    expect(created.isNewUser).toBe(true)
    expect((await latestAudit(created.user.id))?.event).toBe('user.created')
  })

  it('preserves a query string the client registered on its redirect URI', async () => {
    const user = await createUser({ email: uniqueEmail('query') })

    const result = await completeAuthentication(db(), {
      request: await authorizationRequest({ redirectUri: `${SEED.webRedirectUri}?next=%2Fdashboard` }),
      profile: profileFor(user.email),
      ip: null,
      userAgent: null,
    })

    const url = new URL(result.redirectUrl)
    expect(url.searchParams.get('next')).toBe('/dashboard')
    expect(url.searchParams.get('code')).toBeTruthy()
  })

  it('issues nothing at all when the account cannot sign in', async () => {
    const email = uniqueEmail('uninvited')
    const before = await db().select().from(auditLogs)

    await expect(
      completeAuthentication(db(), {
        request: await authorizationRequest(),
        profile: profileFor(email),
        ip: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ code: 'access_denied' })

    // No code, and no audit row that would suggest a successful sign-in.
    expect(await db().select().from(auditLogs)).toHaveLength(before.length)
  })

  it('propagates the provider onto the code so the session records how the user signed in', async () => {
    const user = await createUser({ email: uniqueEmail('provider') })

    const result = await completeAuthentication(db(), {
      request: await authorizationRequest(),
      profile: { ...profileFor(user.email), provider: 'google', providerAccountId: 'sub-provider' },
      ip: null,
      userAgent: null,
    })

    const code = new URL(result.redirectUrl).searchParams.get('code') as string
    await expect(consumeAuthorizationCode(db(), code)).resolves.toMatchObject({ provider: 'google' })
  })
})
