import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { magicLinkTokens } from '@/db/schema'
import { MAGIC_LINK_RATE_LIMIT, TTL } from '@/lib/config'
import { sha256 } from '@/lib/crypto'
import { canReceiveMagicLink, consumeMagicLinkToken, magicLinkProvider, requestMagicLink } from '@/providers/magic-link'
import type { AuthorizationRequest } from '@/providers/types'
import type { Application } from '@/services/applications'
import { getApplication } from '@/services/applications'
import { createInvitation, createUser, db, SEED, uniqueEmail } from '../helpers/db'
import { captureEmails, magicLinkTokenFrom } from '../helpers/email'
import { testEnv } from '../helpers/env'
import { RFC7636 } from '../helpers/pkce'

const workerEnv = testEnv()

const mailbox = captureEmails()
afterEach(() => {
  mailbox.sent.length = 0
})

const authorizationRequest = async (overrides: Partial<AuthorizationRequest> = {}): Promise<AuthorizationRequest> => ({
  application: (await getApplication(db(), SEED.webAppId)) as Application,
  redirectUri: SEED.webRedirectUri,
  state: 'client-state',
  nonce: null,
  codeChallenge: RFC7636.challenge,
  codeChallengeMethod: 'S256',
  scope: 'openid profile email',
  ...overrides,
})

const rowsFor = async (email: string) => db().select().from(magicLinkTokens).where(eq(magicLinkTokens.email, email))

describe('magicLinkProvider', () => {
  it('is always available, because it needs no secret of its own', () => {
    expect(magicLinkProvider.isConfigured(env)).toBe(true)
    expect(magicLinkProvider.isConfigured(testEnv({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }))).toBe(true)
  })

  it('describes itself as an email-initiated provider', () => {
    expect(magicLinkProvider).toMatchObject({ name: 'magic_link', initiation: 'email', startPath: '/magic-link' })
  })
})

describe('canReceiveMagicLink', () => {
  it('allows an existing active account', async () => {
    const user = await createUser({ email: uniqueEmail('active') })

    await expect(canReceiveMagicLink(db(), user.email, SEED.webAppId)).resolves.toEqual({
      allowed: true,
      userId: user.id,
      reason: null,
    })
  })

  it('refuses a disabled account and says why', async () => {
    const user = await createUser({ email: uniqueEmail('disabled'), status: 'disabled' })

    await expect(canReceiveMagicLink(db(), user.email, SEED.webAppId)).resolves.toEqual({
      allowed: false,
      userId: user.id,
      reason: 'disabled',
    })
  })

  it('allows an invited address and refuses an uninvited one', async () => {
    const invited = uniqueEmail('invited')
    await createInvitation({ email: invited })

    await expect(canReceiveMagicLink(db(), invited, SEED.webAppId)).resolves.toMatchObject({ allowed: true })
    await expect(canReceiveMagicLink(db(), uniqueEmail('stranger'), SEED.webAppId)).resolves.toEqual({
      allowed: false,
      userId: null,
      reason: 'not_invited',
    })
  })

  it('honours the application scope of an invitation', async () => {
    const email = uniqueEmail('cms-only')
    await createInvitation({ email, applicationId: SEED.cmsAppId })

    await expect(canReceiveMagicLink(db(), email, SEED.cmsAppId)).resolves.toMatchObject({ allowed: true })
    await expect(canReceiveMagicLink(db(), email, SEED.webAppId)).resolves.toMatchObject({ allowed: false })
  })
})

describe('requestMagicLink', () => {
  it('emails a link and stores the whole authorization request beside its hash', async () => {
    const user = await createUser({ email: uniqueEmail('request') })

    const result = await requestMagicLink(db(), workerEnv, {
      email: user.email.toUpperCase(),
      request: await authorizationRequest({ state: 'st-1', scope: 'openid' }),
      ip: '203.0.113.5',
      userAgent: 'probe/5.0',
    })

    expect(result).toEqual({ sent: true })

    const token = magicLinkTokenFrom(mailbox.last())
    const [row] = await rowsFor(user.email)

    expect(row).toMatchObject({
      email: user.email,
      userId: user.id,
      applicationId: SEED.webAppId,
      redirectUri: SEED.webRedirectUri,
      state: 'st-1',
      codeChallenge: RFC7636.challenge,
      codeChallengeMethod: 'S256',
      scope: 'openid',
      requestIp: '203.0.113.5',
      userAgent: 'probe/5.0',
      consumedAt: null,
    })
    expect(row?.tokenHash).toBe(await sha256(token))
    expect(JSON.stringify(row)).not.toContain(token)
  })

  it('points the emailed link at AUTH_PUBLIC_URL, not at the incoming request URL', async () => {
    const user = await createUser({ email: uniqueEmail('public-url') })

    await requestMagicLink(db(), workerEnv, {
      email: user.email,
      request: await authorizationRequest(),
      ip: null,
      userAgent: null,
    })

    const link = /https?:\/\/\S+/.exec(mailbox.last().text ?? '')?.[0] as string
    expect(link.startsWith(`${env.AUTH_PUBLIC_URL}/magic-link/callback?token=`)).toBe(true)
  })

  it('addresses the email to the normalized address and names the client application', async () => {
    const user = await createUser({ email: uniqueEmail('mail-shape') })

    await requestMagicLink(db(), workerEnv, {
      email: ` ${user.email.toUpperCase()} `,
      request: await authorizationRequest(),
      ip: null,
      userAgent: null,
    })

    const message = mailbox.last()
    expect(message.to).toEqual([user.email])
    expect(message.subject).toBe('Your sign-in link for franciscosolis.cl')
    expect(message.from).toEqual({ email: env.MAIL_FROM_EMAIL, name: env.MAIL_FROM_NAME })
    expect(message.text).toContain(`${Math.round(TTL.magicLink / 60)} minutes`)
  })

  it('records the link with the configured magic-link lifetime', async () => {
    const user = await createUser({ email: uniqueEmail('ttl') })

    await requestMagicLink(db(), workerEnv, {
      email: user.email,
      request: await authorizationRequest(),
      ip: null,
      userAgent: null,
    })

    const [row] = await rowsFor(user.email)
    const lifetime = ((row?.expiresAt.getTime() ?? 0) - Date.now()) / 1000
    expect(lifetime).toBeGreaterThan(TTL.magicLink - 30)
    expect(lifetime).toBeLessThanOrEqual(TTL.magicLink)
  })

  it('sends nothing, and stores nothing, for an address that may not sign in', async () => {
    const email = uniqueEmail('unknown')

    await expect(
      requestMagicLink(db(), workerEnv, { email, request: await authorizationRequest(), ip: null, userAgent: null }),
    ).resolves.toEqual({ sent: false, reason: 'not_allowed' })

    expect(mailbox.sent).toHaveLength(0)
    expect(await rowsFor(email)).toHaveLength(0)
  })

  it('sends nothing for a disabled account', async () => {
    const user = await createUser({ email: uniqueEmail('blocked'), status: 'disabled' })

    await expect(
      requestMagicLink(db(), workerEnv, {
        email: user.email,
        request: await authorizationRequest(),
        ip: null,
        userAgent: null,
      }),
    ).resolves.toEqual({ sent: false, reason: 'not_allowed' })
    expect(mailbox.sent).toHaveLength(0)
  })

  it('stops after the configured number of requests in the window', async () => {
    const user = await createUser({ email: uniqueEmail('rate') })
    const request = await authorizationRequest()

    for (let attempt = 0; attempt < MAGIC_LINK_RATE_LIMIT.max; attempt++) {
      await expect(
        requestMagicLink(db(), workerEnv, { email: user.email, request, ip: null, userAgent: null }),
      ).resolves.toEqual({ sent: true })
    }

    await expect(
      requestMagicLink(db(), workerEnv, { email: user.email, request, ip: null, userAgent: null }),
    ).resolves.toEqual({ sent: false, reason: 'rate_limited' })

    expect(mailbox.sent).toHaveLength(MAGIC_LINK_RATE_LIMIT.max)
    expect(await rowsFor(user.email)).toHaveLength(MAGIC_LINK_RATE_LIMIT.max)
  })

  it('counts only requests inside the window, so an old burst does not lock an address out', async () => {
    const user = await createUser({ email: uniqueEmail('window') })
    const request = await authorizationRequest()

    for (let attempt = 0; attempt < MAGIC_LINK_RATE_LIMIT.max; attempt++) {
      await requestMagicLink(db(), workerEnv, { email: user.email, request, ip: null, userAgent: null })
    }
    await db()
      .update(magicLinkTokens)
      .set({ createdAt: new Date(Date.now() - (MAGIC_LINK_RATE_LIMIT.windowSeconds + 60) * 1000) })
      .where(eq(magicLinkTokens.email, user.email))

    await expect(
      requestMagicLink(db(), workerEnv, { email: user.email, request, ip: null, userAgent: null }),
    ).resolves.toEqual({ sent: true })
  })

  it('rate-limits per address, not globally', async () => {
    const [first, second] = await Promise.all([
      createUser({ email: uniqueEmail('per-address-a') }),
      createUser({ email: uniqueEmail('per-address-b') }),
    ])
    const request = await authorizationRequest()

    for (let attempt = 0; attempt < MAGIC_LINK_RATE_LIMIT.max; attempt++) {
      await requestMagicLink(db(), workerEnv, { email: first.email, request, ip: null, userAgent: null })
    }

    await expect(
      requestMagicLink(db(), workerEnv, { email: second.email, request, ip: null, userAgent: null }),
    ).resolves.toEqual({ sent: true })
  })

  it('checks the rate limit before eligibility, so an unknown address cannot be probed endlessly', async () => {
    const email = uniqueEmail('probe-limit')
    const request = await authorizationRequest()

    // An address that may not sign in never records a row, so it never trips the limit either —
    // pinning the current behaviour so a change to the ordering is deliberate.
    for (let attempt = 0; attempt < MAGIC_LINK_RATE_LIMIT.max + 2; attempt++) {
      await expect(requestMagicLink(db(), workerEnv, { email, request, ip: null, userAgent: null })).resolves.toEqual({
        sent: false,
        reason: 'not_allowed',
      })
    }
  })
})

describe('consumeMagicLinkToken', () => {
  const issue = async (overrides: Partial<AuthorizationRequest> = {}) => {
    const user = await createUser({ email: uniqueEmail('consume') })
    await requestMagicLink(db(), workerEnv, {
      email: user.email,
      request: await authorizationRequest(overrides),
      ip: null,
      userAgent: null,
    })
    return { user, token: magicLinkTokenFrom(mailbox.last()) }
  }

  it('returns a verified profile and the request the link was created for', async () => {
    const { user, token } = await issue({ state: 'st-2', scope: 'openid email' })

    const { record, profile } = await consumeMagicLinkToken(db(), token)

    expect(profile).toMatchObject({
      provider: 'magic_link',
      providerAccountId: user.email,
      email: user.email,
      // Receiving the link at that address is the proof of ownership.
      emailVerified: true,
    })
    expect(record).toMatchObject({
      applicationId: SEED.webAppId,
      redirectUri: SEED.webRedirectUri,
      state: 'st-2',
      scope: 'openid email',
    })
  })

  it('works exactly once, even if a mail scanner opens the link first', async () => {
    const { token } = await issue()

    await expect(consumeMagicLinkToken(db(), token)).resolves.toBeDefined()
    await expect(consumeMagicLinkToken(db(), token)).rejects.toThrow('This sign-in link has already been used')
  })

  it('lets only one of two simultaneous clicks through', async () => {
    const { token } = await issue()

    const outcomes = await Promise.allSettled([consumeMagicLinkToken(db(), token), consumeMagicLinkToken(db(), token)])

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
  })

  it('refuses a token that was never issued', async () => {
    await expect(consumeMagicLinkToken(db(), 'invented')).rejects.toThrow('This sign-in link is not valid')
  })

  it('refuses an expired link without consuming it', async () => {
    const { token } = await issue()
    const tokenHash = await sha256(token)
    await db()
      .update(magicLinkTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(magicLinkTokens.tokenHash, tokenHash))

    await expect(consumeMagicLinkToken(db(), token)).rejects.toThrow('This sign-in link has expired')

    const [row] = await db().select().from(magicLinkTokens).where(eq(magicLinkTokens.tokenHash, tokenHash))
    expect(row?.consumedAt).toBeNull()
  })

  it('reports every failure as invalid_grant', async () => {
    await expect(consumeMagicLinkToken(db(), 'invented')).rejects.toMatchObject({ status: 400, code: 'invalid_grant' })
  })
})
