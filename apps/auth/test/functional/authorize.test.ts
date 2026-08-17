import { SELF } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { auditLogs, authorizationRequests, magicLinkTokens, oauthStates } from '@/db/schema'
import { TTL } from '@/lib/config'
import { sha256 } from '@/lib/crypto'
import { captureEmails, magicLinkTokenFrom } from '../helpers/email'
import { createApplication, createInvitation, createUser, db, SEED, uniqueEmail } from '../helpers/db'
import { withWorkerEnv } from '../helpers/env'
import { RFC7636 } from '../helpers/pkce'

const mailbox = captureEmails()
afterEach(() => {
  mailbox.sent.length = 0
})
afterAll(() => mailbox.restore())

const authorize = (params: Record<string, string> = {}) =>
  SELF.fetch(
    `https://auth.internal/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: SEED.webAppId,
      redirect_uri: SEED.webRedirectUri,
      code_challenge: RFC7636.challenge,
      ...params,
    })}`,
    { redirect: 'manual' },
  )

/** Runs a real authorize leg and recovers the opaque handle out of the page it renders. */
const park = async (params: Record<string, string> = {}) => {
  const response = await authorize(params)
  const html = await response.text()
  const match = /\/oauth\/authorize\/([A-Za-z0-9_-]+)\//.exec(html)
  if (!match) {
    throw new Error(`the sign-in page carries no request handle:\n${html.slice(0, 400)}`)
  }
  const handle = match[1]
  const [row] = await db()
    .select()
    .from(authorizationRequests)
    .where(eq(authorizationRequests.handleHash, await sha256(handle)))
  return { handle, row, html, response }
}

describe('GET /oauth/authorize', () => {
  it('renders a sign-in page naming the client the user is signing in to', async () => {
    const { response, html } = await park()

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/html')
    expect(html).toContain('franciscosolis.cl')
    expect(html).toContain('Email me a sign-in link')
    expect(html).toContain('Continue with Google')
  })

  it('parks the request with exactly what the client asked for, and nothing else', async () => {
    const { row } = await park({ state: 'client-state', nonce: 'n-once', scope: 'openid email' })

    expect(row).toMatchObject({
      applicationId: SEED.webAppId,
      redirectUri: SEED.webRedirectUri,
      state: 'client-state',
      nonce: 'n-once',
      codeChallenge: RFC7636.challenge,
      codeChallengeMethod: 'S256',
      scope: 'openid email',
    })
  })

  it('stores only the hash of the handle, so a database dump cannot resume a sign-in', async () => {
    const { handle, row } = await park()

    expect(row?.handleHash).not.toBe(handle)
    expect(row?.handleHash).toBe(await sha256(handle))
  })

  it('expires the parked request rather than leaving it open indefinitely', async () => {
    const { row } = await park()
    const lifetime = (row as { expiresAt: Date }).expiresAt.getTime() - Date.now()

    expect(lifetime).toBeGreaterThan(0)
    expect(lifetime).toBeLessThanOrEqual(TTL.authorizationRequest * 1000)
  })

  it('records that the flow started', async () => {
    await park()

    const [row] = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.event, 'oauth.authorize.started'))
      .limit(1)

    expect(row).toBeTruthy()
  })

  it('goes straight to Google when the client names the provider', async () => {
    const response = await authorize({ provider: 'google' })

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toContain('https://accounts.google.com/')
  })

  it('hands the user to the configured sign-in front-end when there is one', async () => {
    const response = await withWorkerEnv({ AUTH_LOGIN_URL: 'https://accounts.franciscosolis.cl/sign-in' }, () =>
      authorize(),
    )
    const target = new URL(response.headers.get('Location') as string)

    expect(response.status).toBe(302)
    expect(target.origin + target.pathname).toBe('https://accounts.franciscosolis.cl/sign-in')
    expect(target.searchParams.get('request')).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('refuses an unknown client and an unregistered redirect URI before anything else', async () => {
    const cases: Record<string, string>[] = [{ client_id: 'ghost' }, { redirect_uri: 'https://evil.test/cb' }]
    for (const params of cases) {
      const response = await authorize(params)

      expect(response.status).toBe(400)
      // Never a redirect: there is nowhere trusted to send an error to yet.
      expect(response.headers.get('Location')).toBeNull()
    }
  })

  it('reports a bad response_type through the redirect, once the URI is trusted', async () => {
    const response = await authorize({ response_type: 'token', state: 'abc' })
    const target = new URL(response.headers.get('Location') as string)

    expect(response.status).toBe(302)
    expect(target.origin + target.pathname).toBe(SEED.webRedirectUri)
    expect(target.searchParams.get('error')).toBe('unsupported_response_type')
    expect(target.searchParams.get('state')).toBe('abc')
  })

  it('reports a missing PKCE challenge through the redirect', async () => {
    const response = await SELF.fetch(
      `https://auth.internal/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: SEED.webAppId,
        redirect_uri: SEED.webRedirectUri,
      })}`,
      { redirect: 'manual' },
    )
    const target = new URL(response.headers.get('Location') as string)

    expect(target.searchParams.get('error')).toBe('invalid_request')
    expect(target.searchParams.get('error_description')).toBe('code_challenge is required for this client')
  })

  it('answers prompt=none with login_required, having no session of its own to reuse', async () => {
    const response = await authorize({ prompt: 'none' })
    const target = new URL(response.headers.get('Location') as string)

    expect(target.searchParams.get('error')).toBe('login_required')
  })

  it('refuses a client that is not registered for the authorization code grant', async () => {
    const machine = await createApplication({
      grantTypes: ['client_credentials'],
      redirectUris: ['https://machine.test/cb'],
    })

    const response = await authorize({ client_id: machine.id, redirect_uri: 'https://machine.test/cb' })
    const target = new URL(response.headers.get('Location') as string)

    expect(target.searchParams.get('error')).toBe('unauthorized_client')
  })

  it('lets a confidential client that opted out of PKCE park a request without a challenge', async () => {
    const relyingParty = await createApplication({
      clientSecret: 'cf-access-secret',
      requirePkce: false,
      redirectUris: ['https://access.test/cb'],
    })

    const response = await SELF.fetch(
      `https://auth.internal/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: relyingParty.id,
        redirect_uri: 'https://access.test/cb',
      })}`,
      { redirect: 'manual' },
    )

    expect(response.status).toBe(200)
    const [row] = await db()
      .select()
      .from(authorizationRequests)
      .where(eq(authorizationRequests.applicationId, relyingParty.id))
    expect(row?.codeChallenge).toBeNull()
  })
})

describe('GET /oauth/authorize/:handle', () => {
  it('describes the pending request for a custom sign-in front-end', async () => {
    const { handle } = await park({ login_hint: 'someone@example.test', scope: 'openid' })

    const body = await (await SELF.fetch(`https://auth.internal/oauth/authorize/${handle}`)).json<{
      data: { client_name: string; scope: string; login_hint: string; providers: { name: string; start_url: string }[] }
    }>()

    expect(body.data.client_name).toBe('franciscosolis.cl')
    expect(body.data.scope).toBe('openid')
    expect(body.data.login_hint).toBe('someone@example.test')
    expect(body.data.providers.map((provider) => provider.name)).toEqual(['magic_link', 'google'])
    expect(body.data.providers[1].start_url).toContain(`/oauth/authorize/${handle}/google`)
  })

  it('exposes nothing about the request the browser did not already hold', async () => {
    const { handle } = await park({ state: 'secret-state' })

    const raw = await (await SELF.fetch(`https://auth.internal/oauth/authorize/${handle}`)).text()

    expect(raw).not.toContain('secret-state')
    expect(raw).not.toContain('handle_hash')
  })

  it('refuses an unknown handle', async () => {
    const response = await SELF.fetch('https://auth.internal/oauth/authorize/not-a-real-handle')

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'Unknown sign-in request; please start again' })
  })

  it('refuses an expired one', async () => {
    const { handle, row } = await park()
    await db()
      .update(authorizationRequests)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authorizationRequests.id, (row as { id: string }).id))

    const response = await SELF.fetch(`https://auth.internal/oauth/authorize/${handle}`)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'This sign-in request expired; please start again' })
  })

  it('stops working once the client is deactivated, even mid-flow', async () => {
    const application = await createApplication({ redirectUris: ['https://later.test/cb'] })
    const started = await SELF.fetch(
      `https://auth.internal/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: application.id,
        redirect_uri: 'https://later.test/cb',
        code_challenge: RFC7636.challenge,
      })}`,
    )
    const handle = /\/oauth\/authorize\/([A-Za-z0-9_-]+)\//.exec(await started.text())?.[1] as string

    const { applications } = await import('@/db/schema')
    await db().update(applications).set({ isActive: false }).where(eq(applications.id, application.id))

    expect((await SELF.fetch(`https://auth.internal/oauth/authorize/${handle}`)).status).toBe(400)
  })
})

describe('GET /oauth/authorize/:handle/google', () => {
  it('resumes the parked request into a Google redirect, carrying the client parameters over', async () => {
    const { handle, row } = await park({ state: 'client-state', nonce: 'n-once' })

    const response = await SELF.fetch(`https://auth.internal/oauth/authorize/${handle}/google`, {
      redirect: 'manual',
    })
    const target = new URL(response.headers.get('Location') as string)
    const [state] = await db()
      .select()
      .from(oauthStates)
      .where(eq(oauthStates.stateHash, await sha256(target.searchParams.get('state') as string)))

    expect(response.status).toBe(302)
    expect(target.origin).toBe('https://accounts.google.com')
    expect(state).toMatchObject({
      applicationId: SEED.webAppId,
      redirectUri: row?.redirectUri as string,
      clientState: 'client-state',
      clientNonce: 'n-once',
      codeChallenge: RFC7636.challenge,
    })
  })

  it('sends our own PKCE challenge and nonce to Google, not the client\'s', async () => {
    const { handle } = await park()

    const response = await SELF.fetch(`https://auth.internal/oauth/authorize/${handle}/google`, {
      redirect: 'manual',
    })
    const target = new URL(response.headers.get('Location') as string)

    expect(target.searchParams.get('code_challenge')).not.toBe(RFC7636.challenge)
    expect(target.searchParams.get('nonce')).toBeTruthy()
  })

  it('answers 503 when Google is not configured on this deployment', async () => {
    const { handle } = await park()

    const response = await withWorkerEnv({ GOOGLE_CLIENT_SECRET: '' }, () =>
      SELF.fetch(`https://auth.internal/oauth/authorize/${handle}/google`, { redirect: 'manual' }),
    )

    expect(response.status).toBe(503)
  })

  it('can be re-entered, because a user may change their mind about the provider', async () => {
    const { handle } = await park()

    for (const _ of [1, 2]) {
      const response = await SELF.fetch(`https://auth.internal/oauth/authorize/${handle}/google`, {
        redirect: 'manual',
      })
      expect(response.status).toBe(302)
    }
  })
})

describe('POST /oauth/authorize/:handle/magic-link', () => {
  const submit = (handle: string, body: Record<string, string>, json = false) =>
    SELF.fetch(`https://auth.internal/oauth/authorize/${handle}/magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
      body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
    })

  it('emails a link carrying the parked request, and confirms it on the page', async () => {
    const user = await createUser()
    const { handle, row } = await park({ state: 'client-state', nonce: 'n-once' })

    const response = await submit(handle, { email: user.email })
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('a link is on its way')

    const token = magicLinkTokenFrom(mailbox.last())
    const [stored] = await db()
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.tokenHash, await sha256(token)))

    expect(stored).toMatchObject({
      applicationId: SEED.webAppId,
      redirectUri: row?.redirectUri as string,
      state: 'client-state',
      nonce: 'n-once',
      codeChallenge: RFC7636.challenge,
    })
  })

  it('answers JSON to a JSON request, for a front-end driving this itself', async () => {
    const user = await createUser()
    const { handle } = await park()

    const response = await submit(handle, { email: user.email }, true)

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ code: 202, data: { expires_in: TTL.magicLink } })
  })

  it('says the same thing for an address that cannot sign in, so it is not an oracle', async () => {
    const { handle } = await park()

    const known = await submit(handle, { email: (await createUser()).email }, true)
    const unknown = await submit(handle, { email: uniqueEmail('stranger') }, true)

    expect(await known.json()).toEqual(await unknown.json())
    expect(mailbox.sent).toHaveLength(1)
  })

  it('still sends to an invited address that has no account yet', async () => {
    const email = uniqueEmail('invited')
    await createInvitation({ email })
    const { handle } = await park()

    await submit(handle, { email }, true)

    expect(mailbox.sent).toHaveLength(1)
  })

  it('re-renders the form with an error for a malformed address, without sending anything', async () => {
    const { handle } = await park()

    const response = await submit(handle, { email: 'not-an-address' })

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('A valid email address is required')
    expect(mailbox.sent).toHaveLength(0)
  })

  it('escapes what it echoes back into the page', async () => {
    const { handle } = await park()

    const html = await (await submit(handle, { email: '<script>alert(1)</script>' })).text()

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('refuses an unknown handle rather than emailing anything', async () => {
    const response = await submit('not-a-real-handle', { email: (await createUser()).email }, true)

    expect(response.status).toBe(400)
    expect(mailbox.sent).toHaveLength(0)
  })
})
