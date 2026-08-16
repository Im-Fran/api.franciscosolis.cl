import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { AppEnv } from '@/env'
import { CODE_CHALLENGE_METHOD, TTL } from '@/lib/config'
import { buildErrorRedirect, OAuthException, RedirectValidationException } from '@/lib/errors'
import { consumeMagicLinkToken, requestMagicLink } from '@/providers/magic-link'
import { getApplication, normalizeScope, resolveClient, validatePkceParameters } from '@/services/applications'
import { getRequestContext, recordAudit } from '@/services/audit'
import { completeAuthentication } from '@/services/authorization'

const app = new Hono<AppEnv>()

const requestSchema = v.object({
  email: v.pipe(v.string(), v.trim(), v.email('A valid email address is required')),
  client_id: v.pipe(v.string(), v.minLength(1)),
  redirect_uri: v.pipe(v.string(), v.url('redirect_uri must be an absolute URL')),
  state: v.optional(v.string()),
  code_challenge: v.pipe(v.string(), v.minLength(1)),
  code_challenge_method: v.optional(v.literal(CODE_CHALLENGE_METHOD)),
  scope: v.optional(v.string()),
})

const requestResponseSchema = v.object({
  code: v.literal(202),
  data: v.object({
    message: v.string(),
    expires_in: v.number(),
  }),
})

app.post(
  '/magic-link',
  describeRoute({
    description:
      'Starts a magic link sign-in. Always answers 202 regardless of whether the address exists or was invited, so this endpoint cannot be used to discover which addresses have an account. The link is emailed and is valid once.',
    tags: ['Magic Link'],
    responses: {
      202: {
        description: 'The request was accepted; an email is sent only if the address may sign in',
        content: { 'application/json': { schema: resolver(requestResponseSchema) } },
      },
      400: { description: 'Invalid client, redirect URI or PKCE parameters' },
    },
  }),
  validator('json', requestSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const context = getRequestContext(c)

    const { application, redirectUri } = await resolveClient(db, body.client_id, body.redirect_uri)
    const pkce = validatePkceParameters(body.code_challenge, body.code_challenge_method)
    const scope = normalizeScope(body.scope)

    const result = await requestMagicLink(db, c.env, {
      email: body.email,
      request: {
        application,
        redirectUri,
        state: body.state ?? null,
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: pkce.codeChallengeMethod,
        scope,
      },
      ...context,
    })

    await recordAudit(db, {
      event: result.sent
        ? 'magic_link.requested'
        : result.reason === 'rate_limited'
          ? 'magic_link.rate_limited'
          : 'signup.rejected',
      applicationId: application.id,
      ...context,
      // The address is recorded, but never whether it resolved to an account — that stays out of
      // the response, and the audit row is the place to look it up.
      metadata: { email: body.email, sent: result.sent },
    })

    return c.json(
      {
        code: 202,
        data: {
          message: 'If this address can sign in, a link is on its way.',
          expires_in: TTL.magicLink,
        },
      },
      202,
    )
  },
)

const callbackSchema = v.object({
  token: v.pipe(v.string(), v.minLength(1)),
})

app.get(
  '/magic-link/callback',
  describeRoute({
    description:
      'Consumes an emailed magic link and redirects back to the client application with a single-use authorization code. The redirect target comes from the stored request, not from the URL, so the link cannot be rewritten to send the code somewhere else.',
    tags: ['Magic Link'],
    responses: {
      302: { description: 'Redirect to the client application with `code` and `state`' },
      400: { description: 'The link is invalid, expired or already used' },
    },
  }),
  validator('query', callbackSchema),
  async (c) => {
    const { token } = c.req.valid('query')
    const db = getDb(c.env)
    const context = getRequestContext(c)

    const { record, profile } = await consumeMagicLinkToken(db, token)

    const application = await getApplication(db, record.applicationId)
    if (!application) {
      throw new RedirectValidationException('The application this link was issued for is no longer available')
    }

    const request = {
      application,
      redirectUri: record.redirectUri,
      state: record.state,
      codeChallenge: record.codeChallenge,
      codeChallengeMethod: record.codeChallengeMethod,
      scope: record.scope ?? '',
    }

    try {
      const { redirectUrl } = await completeAuthentication(db, c.env, { request, profile, ...context })
      await recordAudit(db, {
        event: 'magic_link.consumed',
        applicationId: application.id,
        ...context,
        metadata: { email: record.email },
      })
      return c.redirect(redirectUrl, 302)
    } catch (error) {
      // The redirect URI came from the stored request and was validated when the link was created,
      // so it is safe to hand the failure back to the client application rather than dead-ending
      // the user on a JSON error page.
      if (error instanceof OAuthException) {
        await recordAudit(db, {
          event: 'magic_link.rejected',
          applicationId: application.id,
          ...context,
          metadata: { email: record.email, reason: error.code },
        })
        return c.redirect(buildErrorRedirect(record.redirectUri, error.code, error.description, record.state), 302)
      }
      throw error
    }
  },
)

export default app
