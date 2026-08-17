import { SELF, env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { auditLogs, sessions } from '@/db/schema'
import { verifyAccessToken } from '@/lib/jwt'
import { issueAuthorizationCode } from '@/services/tokens'
import { createApplication, createSecret, createUser, db, SEED } from '../helpers/db'
import { RFC7636 } from '../helpers/pkce'

type TokenBody = {
  access_token: string
  refresh_token?: string
  id_token?: string
  session_id?: string
  scope: string | null
}

const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  SELF.fetch(`https://auth.internal${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  })

const basic = (clientId: string, clientSecret: string) => ({
  Authorization: `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`,
})

/** A confidential client plus a code ready to be exchanged for it. */
const confidentialClient = async (
  overrides: { secret?: string; authMethod?: 'client_secret_post' | 'client_secret_basic'; requirePkce?: boolean } = {},
) => {
  const secret = overrides.secret ?? `secret-${crypto.randomUUID()}`
  const redirectUri = 'https://confidential.test/cb'
  const application = await createApplication({
    redirectUris: [redirectUri],
    clientSecret: secret,
    tokenEndpointAuthMethod: overrides.authMethod ?? 'client_secret_post',
    requirePkce: overrides.requirePkce ?? true,
  })

  const grantCode = async () => {
    const user = await createUser()
    return issueAuthorizationCode(db(), {
      userId: user.id,
      applicationId: application.id,
      provider: 'magic_link',
      redirectUri,
      nonce: null,
      codeChallenge: overrides.requirePkce === false ? null : RFC7636.challenge,
      codeChallengeMethod: overrides.requirePkce === false ? null : 'S256',
      scope: 'openid email',
    })
  }

  return { application, secret, redirectUri, grantCode }
}

describe('client authentication at the token endpoint', () => {
  it('accepts client_secret_post from a client registered for it', async () => {
    const client = await confidentialClient()

    const response = await post('/oauth/token', {
      grant_type: 'authorization_code',
      client_id: client.application.id,
      client_secret: client.secret,
      code: await client.grantCode(),
      redirect_uri: client.redirectUri,
      code_verifier: RFC7636.verifier,
    })

    expect(response.status).toBe(200)
  })

  it('accepts HTTP Basic from a client registered for it', async () => {
    const client = await confidentialClient({ authMethod: 'client_secret_basic' })

    const response = await post(
      '/oauth/token',
      {
        grant_type: 'authorization_code',
        code: await client.grantCode(),
        redirect_uri: client.redirectUri,
        code_verifier: RFC7636.verifier,
      },
      basic(client.application.id, client.secret),
    )

    expect(response.status).toBe(200)
  })

  it('holds a client to the one envelope it registered', async () => {
    const client = await confidentialClient({ authMethod: 'client_secret_basic' })

    const response = await post('/oauth/token', {
      grant_type: 'authorization_code',
      client_id: client.application.id,
      client_secret: client.secret,
      code: await client.grantCode(),
      redirect_uri: client.redirectUri,
      code_verifier: RFC7636.verifier,
    })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_client',
      error_description: 'This client must authenticate with client_secret_basic',
    })
  })

  it('refuses credentials sent in both envelopes at once', async () => {
    const client = await confidentialClient()

    const response = await post(
      '/oauth/token',
      {
        grant_type: 'authorization_code',
        client_id: client.application.id,
        client_secret: client.secret,
        code: await client.grantCode(),
        redirect_uri: client.redirectUri,
        code_verifier: RFC7636.verifier,
      },
      basic(client.application.id, client.secret),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' })
  })

  it('records a failed client authentication in the audit trail', async () => {
    const client = await confidentialClient()

    await post('/oauth/token', {
      grant_type: 'refresh_token',
      client_id: client.application.id,
      client_secret: 'wrong',
      refresh_token: 'irrelevant',
    })

    const [row] = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.applicationId, client.application.id))

    expect(row?.event).toBe('client.authentication_failed')
    expect(JSON.stringify(row?.metadata)).not.toContain('wrong')
  })

  it('accepts either secret during a rotation grace period', async () => {
    const client = await confidentialClient({ secret: 'rotating-old' })
    await createSecret(client.application.id, 'rotating-new')

    for (const secret of ['rotating-old', 'rotating-new']) {
      const response = await post('/oauth/token', {
        grant_type: 'authorization_code',
        client_id: client.application.id,
        client_secret: secret,
        code: await client.grantCode(),
        redirect_uri: client.redirectUri,
        code_verifier: RFC7636.verifier,
      })
      expect(response.status).toBe(200)
    }
  })

  it('refuses a secret whose grace period has run out', async () => {
    const client = await confidentialClient({ secret: 'still-valid' })
    await createSecret(client.application.id, 'grace-ended', { expiresAt: new Date(Date.now() - 1000) })

    const response = await post('/oauth/token', {
      grant_type: 'authorization_code',
      client_id: client.application.id,
      client_secret: 'grace-ended',
      code: await client.grantCode(),
      redirect_uri: client.redirectUri,
      code_verifier: RFC7636.verifier,
    })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error_description: 'Invalid client credentials' })
  })
})

describe('a confidential client that opted out of PKCE', () => {
  it('exchanges a code without a verifier', async () => {
    const client = await confidentialClient({ requirePkce: false })

    const response = await post('/oauth/token', {
      grant_type: 'authorization_code',
      client_id: client.application.id,
      client_secret: client.secret,
      code: await client.grantCode(),
      redirect_uri: client.redirectUri,
    })

    expect(response.status).toBe(200)
  })

  it('is still refused if it sends a verifier for a code minted without a challenge', async () => {
    const client = await confidentialClient({ requirePkce: false })

    const response = await post('/oauth/token', {
      grant_type: 'authorization_code',
      client_id: client.application.id,
      client_secret: client.secret,
      code: await client.grantCode(),
      redirect_uri: client.redirectUri,
      code_verifier: RFC7636.verifier,
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error_description: 'This authorization code was issued without a code_challenge',
    })
  })

  it('does not unbind a code that was already minted with a challenge', async () => {
    const client = await confidentialClient()

    const response = await post('/oauth/token', {
      grant_type: 'authorization_code',
      client_id: client.application.id,
      client_secret: client.secret,
      code: await client.grantCode(),
      redirect_uri: client.redirectUri,
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error_description: 'code_verifier is required for this authorization code',
    })
  })
})

describe('POST /oauth/token — client_credentials', () => {
  const machineClient = async (secret = `machine-${crypto.randomUUID()}`) => {
    const application = await createApplication({
      clientSecret: secret,
      grantTypes: ['client_credentials'],
    })
    return { application, secret }
  }

  it('issues an access token for the client itself, with no session and no refresh token', async () => {
    const { application, secret } = await machineClient()

    const response = await post('/oauth/token', {
      grant_type: 'client_credentials',
      client_id: application.id,
      client_secret: secret,
    })
    const body = await response.json<TokenBody>()

    expect(response.status).toBe(200)
    expect(body.refresh_token).toBeUndefined()
    expect(body.id_token).toBeUndefined()
    expect(body.session_id).toBeUndefined()

    const claims = await verifyAccessToken(env, body.access_token)
    expect(claims.sub).toBe(application.id)
    expect(claims.client_id).toBe(application.id)
    expect(claims.sid).toBeUndefined()
  })

  it('leaves no session row behind', async () => {
    const { application, secret } = await machineClient()

    await post('/oauth/token', { grant_type: 'client_credentials', client_id: application.id, client_secret: secret })

    const rows = await db().select().from(sessions).where(eq(sessions.applicationId, application.id))
    expect(rows).toEqual([])
  })

  it('refuses a client that is not registered for the grant', async () => {
    const secret = `no-cc-${crypto.randomUUID()}`
    const application = await createApplication({ clientSecret: secret })

    const response = await post('/oauth/token', {
      grant_type: 'client_credentials',
      client_id: application.id,
      client_secret: secret,
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'unauthorized_client' })
  })

  it('refuses a public client, which has no secret to stand between it and this grant', async () => {
    const application = await createApplication({ grantTypes: ['client_credentials'] })

    const response = await post('/oauth/token', { grant_type: 'client_credentials', client_id: application.id })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error_description: 'The client_credentials grant requires a confidential client',
    })
  })

  it('narrows the scope to what the client may ask for', async () => {
    const secret = `scoped-${crypto.randomUUID()}`
    const application = await createApplication({
      clientSecret: secret,
      grantTypes: ['client_credentials'],
      scopes: ['openid'],
    })

    const refused = await post('/oauth/token', {
      grant_type: 'client_credentials',
      client_id: application.id,
      client_secret: secret,
      scope: 'openid email',
    })

    expect(refused.status).toBe(400)
    await expect(refused.json()).resolves.toMatchObject({ error: 'invalid_scope' })
  })

  it('is refused by every route that acts on behalf of a user', async () => {
    const { application, secret } = await machineClient()
    const body = await (
      await post('/oauth/token', {
        grant_type: 'client_credentials',
        client_id: application.id,
        client_secret: secret,
      })
    ).json<TokenBody>()

    const response = await SELF.fetch('https://auth.internal/me', {
      headers: { Authorization: `Bearer ${body.access_token}` },
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: 'This endpoint requires an access token issued for a user',
    })
  })
})

describe('POST /oauth/introspect', () => {
  const signIn = async () => {
    const user = await createUser()
    const code = await issueAuthorizationCode(db(), {
      userId: user.id,
      applicationId: SEED.webAppId,
      provider: 'magic_link',
      redirectUri: SEED.webRedirectUri,
      nonce: null,
      codeChallenge: RFC7636.challenge,
      codeChallengeMethod: 'S256',
      scope: 'openid email',
    })
    const body = await (
      await post('/oauth/token', {
        grant_type: 'authorization_code',
        client_id: SEED.webAppId,
        code,
        redirect_uri: SEED.webRedirectUri,
        code_verifier: RFC7636.verifier,
      })
    ).json<TokenBody & { session_id: string; refresh_token: string }>()
    return { user, ...body }
  }

  const introspect = (fields: Record<string, string>) =>
    post('/oauth/introspect', { client_id: SEED.webAppId, ...fields })

  it('reports a live access token as active, with what it stands for', async () => {
    const tokens = await signIn()

    const body = await (await introspect({ token: tokens.access_token })).json<Record<string, unknown>>()

    expect(body).toMatchObject({
      active: true,
      token_type: 'access_token',
      client_id: SEED.webAppId,
      sub: tokens.user.id,
      username: tokens.user.email,
      sid: tokens.session_id,
      scope: 'openid email',
      iss: env.AUTH_ISSUER,
    })
  })

  it('reports a live refresh token as active', async () => {
    const tokens = await signIn()

    const body = await (await introspect({ token: tokens.refresh_token })).json<Record<string, unknown>>()

    expect(body).toMatchObject({ active: true, token_type: 'refresh_token', sub: tokens.user.id })
  })

  it('reflects a revocation, which an offline signature check cannot see', async () => {
    const tokens = await signIn()
    await db().update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, tokens.session_id))

    await expect((await introspect({ token: tokens.access_token })).json()).resolves.toEqual({ active: false })
    await expect((await introspect({ token: tokens.refresh_token })).json()).resolves.toEqual({ active: false })
  })

  it('reports another client\'s token as inactive rather than describing it', async () => {
    const tokens = await signIn()
    const other = await createApplication()

    const body = await (
      await post('/oauth/introspect', { client_id: other.id, token: tokens.access_token })
    ).json()

    expect(body).toEqual({ active: false })
  })

  it('reports an unknown value as inactive', async () => {
    await expect((await introspect({ token: 'nothing-like-a-token' })).json()).resolves.toEqual({ active: false })
  })

  it('answers correctly however the token_type_hint guesses', async () => {
    const tokens = await signIn()

    for (const hint of ['access_token', 'refresh_token']) {
      const body = await (await introspect({ token: tokens.access_token, token_type_hint: hint })).json<{
        active: boolean
        token_type?: string
      }>()
      expect(body).toMatchObject({ active: true, token_type: 'access_token' })
    }
  })

  it('describes a client credentials token, which has no user behind it', async () => {
    const secret = `introspect-${crypto.randomUUID()}`
    const application = await createApplication({ clientSecret: secret, grantTypes: ['client_credentials'] })
    const issued = await (
      await post('/oauth/token', {
        grant_type: 'client_credentials',
        client_id: application.id,
        client_secret: secret,
      })
    ).json<TokenBody>()

    const body = await (
      await post('/oauth/introspect', {
        client_id: application.id,
        client_secret: secret,
        token: issued.access_token,
      })
    ).json<Record<string, unknown>>()

    expect(body).toMatchObject({ active: true, sub: application.id })
    expect(body.username).toBeUndefined()
    expect(body.sid).toBeUndefined()
  })

  it('requires the caller to authenticate as a registered client', async () => {
    const tokens = await signIn()

    const response = await post('/oauth/introspect', { client_id: 'ghost', token: tokens.access_token })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_client' })
  })

  it('never echoes the token it was asked about', async () => {
    const tokens = await signIn()

    const raw = await (await introspect({ token: tokens.access_token })).text()

    expect(raw).not.toContain(tokens.access_token)
  })
})

describe('POST /oauth/revoke', () => {
  const signIn = async () => {
    const user = await createUser()
    const code = await issueAuthorizationCode(db(), {
      userId: user.id,
      applicationId: SEED.webAppId,
      provider: 'magic_link',
      redirectUri: SEED.webRedirectUri,
      nonce: null,
      codeChallenge: RFC7636.challenge,
      codeChallengeMethod: 'S256',
      scope: 'openid email',
    })
    return (
      await post('/oauth/token', {
        grant_type: 'authorization_code',
        client_id: SEED.webAppId,
        code,
        redirect_uri: SEED.webRedirectUri,
        code_verifier: RFC7636.verifier,
      })
    ).json<TokenBody & { session_id: string; refresh_token: string }>()
  }

  it('accepts an access token and kills the session behind it', async () => {
    const tokens = await signIn()

    const response = await post('/oauth/revoke', { client_id: SEED.webAppId, token: tokens.access_token })

    expect(response.status).toBe(200)
    const [session] = await db().select().from(sessions).where(eq(sessions.id, tokens.session_id))
    expect(session?.revokedAt).not.toBeNull()
  })

  it('still accepts a refresh token, as it always did', async () => {
    const tokens = await signIn()

    await post('/oauth/revoke', { client_id: SEED.webAppId, token: tokens.refresh_token })

    const [session] = await db().select().from(sessions).where(eq(sessions.id, tokens.session_id))
    expect(session?.revokedAt).not.toBeNull()
  })

  it('ignores an access token issued to a different client', async () => {
    const tokens = await signIn()
    const other = await createApplication()

    const response = await post('/oauth/revoke', { client_id: other.id, token: tokens.access_token })

    expect(response.status).toBe(200)
    const [session] = await db().select().from(sessions).where(eq(sessions.id, tokens.session_id))
    expect(session?.revokedAt).toBeNull()
  })
})
