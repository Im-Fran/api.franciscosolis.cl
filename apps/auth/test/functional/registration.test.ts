import { SELF } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auditLogs, authorizationRequests, users } from '@/db/schema'
import { TURNSTILE_VERIFY_ENDPOINT } from '@/lib/turnstile'
import { updateSettings } from '@/services/settings'
import { db, SEED, uniqueEmail } from '../helpers/db'
import { captureEmails, magicLinkTokenFrom } from '../helpers/email'
import { withWorkerEnv } from '../helpers/env'
import { restoreFetch, stubFetch } from '../helpers/http'
import { RFC7636 } from '../helpers/pkce'

const mailbox = captureEmails()
afterEach(() => {
  mailbox.sent.length = 0
  restoreFetch()
})
afterAll(() => mailbox.restore())

beforeEach(async () => {
  await updateSettings(db(), { registration_open: false }, null)
})

/** A deployment that challenges: both halves of the keypair present. */
const TURNSTILE_KEYS = { TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: 'secret-half' }

const siteverify = (success: boolean) =>
  stubFetch({
    [TURNSTILE_VERIFY_ENDPOINT]: () =>
      new Response(JSON.stringify({ success, 'error-codes': success ? [] : ['invalid-input-response'] })),
  })

const requestLink = (body: Record<string, unknown>) =>
  SELF.fetch('https://auth.internal/magic-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.44' },
    body: JSON.stringify({
      client_id: SEED.webAppId,
      redirect_uri: SEED.webRedirectUri,
      code_challenge: RFC7636.challenge,
      ...body,
    }),
  })

const callback = (token: string) =>
  SELF.fetch(`https://auth.internal/magic-link/callback?token=${encodeURIComponent(token)}`, { redirect: 'manual' })

/** Parks a real authorization request and hands back its handle. */
const park = async () => {
  const response = await SELF.fetch(
    `https://auth.internal/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: SEED.webAppId,
      redirect_uri: SEED.webRedirectUri,
      code_challenge: RFC7636.challenge,
    })}`,
    { redirect: 'manual' },
  )
  const location = response.headers.get('Location')
  const handle = location && new URL(location).searchParams.get('request')
  if (!handle) {
    throw new Error(`the authorize response carries no request handle: ${response.status} ${location}`)
  }
  return handle
}

describe('open registration', () => {
  it('sends nothing to an uninvited address while registration is closed', async () => {
    const email = uniqueEmail('closed')

    expect((await requestLink({ email })).status).toBe(202)

    expect(mailbox.sent).toHaveLength(0)
  })

  it('emails an uninvited address once registration is open, and the link creates the account', async () => {
    await updateSettings(db(), { registration_open: true }, null)
    const email = uniqueEmail('opened')

    expect((await requestLink({ email })).status).toBe(202)
    expect(mailbox.sent).toHaveLength(1)

    const response = await callback(magicLinkTokenFrom(mailbox.last()))

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toContain(`${SEED.webRedirectUri}?code=`)

    const [created] = await db().select().from(users).where(eq(users.email, email))
    expect(created).toMatchObject({ email, status: 'active' })

    const [entry] = await db()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.userId, created.id), eq(auditLogs.event, 'user.created')))
    expect(JSON.parse(entry?.metadata ?? '{}')).toMatchObject({ signup: 'open_registration' })
  })

  it('refuses a link that was emailed while registration was open but is clicked after it closed', async () => {
    await updateSettings(db(), { registration_open: true }, null)
    const email = uniqueEmail('closed-midway')
    await requestLink({ email })
    const token = magicLinkTokenFrom(mailbox.last())

    await updateSettings(db(), { registration_open: false }, null)
    const response = await callback(token)

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toContain('error=access_denied')
    await expect(db().select().from(users).where(eq(users.email, email))).resolves.toHaveLength(0)
  })

  it('is reported to the sign-in front-end on the parked request and on the status endpoint', async () => {
    await updateSettings(db(), { registration_open: true }, null)
    const handle = await park()

    const parked = await (await SELF.fetch(`https://auth.internal/oauth/authorize/${handle}`)).json<{
      data: { registration_open: boolean; turnstile: { required: boolean; site_key: string | null } }
    }>()
    const status = await (await SELF.fetch('https://auth.internal/')).json<{ data: { registration_open: boolean } }>()

    expect(parked.data.registration_open).toBe(true)
    expect(parked.data.turnstile).toEqual({ required: false, site_key: null })
    expect(status.data.registration_open).toBe(true)
  })
})

describe('Turnstile', () => {
  it('refuses POST /magic-link without a token, writing nothing and sending nothing', async () => {
    const { calls } = siteverify(true)

    const response = await withWorkerEnv(TURNSTILE_KEYS, () => requestLink({ email: uniqueEmail('nobot') }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' })
    expect(mailbox.sent).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('refuses a token Cloudflare does not accept', async () => {
    siteverify(false)

    const response = await withWorkerEnv(TURNSTILE_KEYS, () =>
      requestLink({ email: uniqueEmail('forged'), turnstile_token: 'forged-token' }),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'access_denied' })
    expect(mailbox.sent).toHaveLength(0)
  })

  it('lets a solved challenge through, and tells Cloudflare who asked', async () => {
    const { calls } = siteverify(true)
    await updateSettings(db(), { registration_open: true }, null)

    const response = await withWorkerEnv(TURNSTILE_KEYS, () =>
      requestLink({ email: uniqueEmail('human'), turnstile_token: 'solved-token' }),
    )

    expect(response.status).toBe(202)
    expect(mailbox.sent).toHaveLength(1)
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.body ?? ''))).toMatchObject({
      response: 'solved-token',
      remoteip: '203.0.113.44',
    })
  })

  it('guards the parked request the sign-in front-end posts to, and advertises its site key there', async () => {
    siteverify(false)
    const handle = await park()

    const { described, refused } = await withWorkerEnv(TURNSTILE_KEYS, async () => ({
      described: await (await SELF.fetch(`https://auth.internal/oauth/authorize/${handle}`)).json<{
        data: { turnstile: { required: boolean; site_key: string | null } }
      }>(),
      refused: await SELF.fetch(`https://auth.internal/oauth/authorize/${handle}/magic-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: uniqueEmail('parked'), turnstile_token: 'forged-token' }),
      }),
    }))

    expect(described.data.turnstile).toEqual({ required: true, site_key: TURNSTILE_KEYS.TURNSTILE_SITE_KEY })
    expect(refused.status).toBe(400)
    expect(mailbox.sent).toHaveLength(0)
    // The parked row survives a refused attempt: it is deliberately not single-use.
    await expect(db().select().from(authorizationRequests)).resolves.not.toHaveLength(0)
  })

  it('does not challenge at all on a deployment holding only half a keypair', async () => {
    const { calls } = siteverify(true)
    await updateSettings(db(), { registration_open: true }, null)

    const response = await withWorkerEnv({ TURNSTILE_SITE_KEY: '1x00000000000000000000AA' }, () =>
      requestLink({ email: uniqueEmail('halfkey') }),
    )

    expect(response.status).toBe(202)
    expect(mailbox.sent).toHaveLength(1)
    expect(calls).toHaveLength(0)
  })
})
