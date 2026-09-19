import { afterEach, describe, expect, it } from 'vitest'
import { OAuthException } from '@/lib/errors'
import { describeTurnstile, isTurnstileConfigured, TURNSTILE_VERIFY_ENDPOINT, verifyTurnstile } from '@/lib/turnstile'
import { testEnv } from '../helpers/env'
import { restoreFetch, stubFetch } from '../helpers/http'

afterEach(restoreFetch)

const configured = testEnv({ TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: 'secret-half' })

const siteverify = (body: unknown, status = 200) =>
  stubFetch({ [TURNSTILE_VERIFY_ENDPOINT]: () => new Response(JSON.stringify(body), { status }) })

describe('isTurnstileConfigured', () => {
  it('needs both halves of the keypair', () => {
    expect(isTurnstileConfigured(configured)).toBe(true)
    expect(isTurnstileConfigured(testEnv({ TURNSTILE_SITE_KEY: 'only-the-public-half' }))).toBe(false)
    expect(isTurnstileConfigured(testEnv({ TURNSTILE_SECRET_KEY: 'only-the-private-half' }))).toBe(false)
    expect(isTurnstileConfigured(testEnv())).toBe(false)
  })
})

describe('describeTurnstile', () => {
  it('hands out the public half only, and only where the pair is complete', () => {
    expect(describeTurnstile(configured)).toEqual({ required: true, site_key: '1x00000000000000000000AA' })
    expect(describeTurnstile(testEnv({ TURNSTILE_SECRET_KEY: 'half' }))).toEqual({ required: false, site_key: null })
  })
})

describe('verifyTurnstile', () => {
  it('does nothing at all on a deployment with no keypair, token or not', async () => {
    const { calls } = siteverify({ success: false })

    await expect(verifyTurnstile(testEnv(), undefined, null)).resolves.toBeUndefined()
    await expect(verifyTurnstile(testEnv(), 'anything', null)).resolves.toBeUndefined()

    expect(calls).toHaveLength(0)
  })

  it('refuses a missing token without asking Cloudflare', async () => {
    const { calls } = siteverify({ success: true })

    await expect(verifyTurnstile(configured, undefined, null)).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    })
    expect(calls).toHaveLength(0)
  })

  it('posts the secret, the token and the caller IP, and passes on success', async () => {
    const { calls } = siteverify({ success: true })

    await expect(verifyTurnstile(configured, 'widget-token', '203.0.113.7')).resolves.toBeUndefined()

    expect(calls).toHaveLength(1)
    const body = new URLSearchParams(calls[0]?.body ?? '')
    expect(Object.fromEntries(body)).toEqual({
      secret: 'secret-half',
      response: 'widget-token',
      remoteip: '203.0.113.7',
    })
  })

  it('leaves the IP out when the edge did not give one', async () => {
    const { calls } = siteverify({ success: true })

    await verifyTurnstile(configured, 'widget-token', null)

    expect(new URLSearchParams(calls[0]?.body ?? '').has('remoteip')).toBe(false)
  })

  it('refuses a token Cloudflare rejects, without repeating why', async () => {
    siteverify({ success: false, 'error-codes': ['invalid-input-response'] })

    const error = await verifyTurnstile(configured, 'forged', null).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(OAuthException)
    expect(error).toMatchObject({ status: 400, code: 'access_denied' })
    expect((error as OAuthException).description).not.toContain('invalid-input-response')
  })

  it('fails closed when Cloudflare cannot be reached', async () => {
    stubFetch({
      [TURNSTILE_VERIFY_ENDPOINT]: () => {
        throw new Error('network down')
      },
    })

    await expect(verifyTurnstile(configured, 'widget-token', null)).rejects.toMatchObject({
      status: 503,
      code: 'temporarily_unavailable',
    })
  })
})
