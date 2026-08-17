import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { AppEnv } from '@/env'
import { CODE_CHALLENGE_METHOD, RESPONSE_TYPE, TTL } from '@/lib/config'
import { buildErrorRedirect, OAuthException, RedirectValidationException } from '@/lib/errors'
import { renderLoginPage } from '@/lib/login-page'
import { googleProvider } from '@/providers/google'
import { getAvailableProviders } from '@/providers'
import { requestMagicLink } from '@/providers/magic-link'
import {
  assertGrantAllowed,
  normalizeScope,
  resolveClient,
  validatePkceParameters,
} from '@/services/applications'
import { getRequestContext, recordAudit } from '@/services/audit'
import {
  createAuthorizationRequest,
  loadAuthorizationRequest,
  toAuthorizationRequest,
} from '@/services/authorization-requests'
import { startGoogleFlow } from '@/services/authorization'

const app = new Hono<AppEnv>()

const authorizeSchema = v.object({
  response_type: v.pipe(v.string(), v.minLength(1)),
  client_id: v.pipe(v.string(), v.minLength(1)),
  redirect_uri: v.pipe(v.string(), v.url('redirect_uri must be an absolute URL')),
  scope: v.optional(v.string()),
  state: v.optional(v.string()),
  nonce: v.optional(v.string()),
  code_challenge: v.optional(v.string()),
  code_challenge_method: v.optional(v.string()),
  /** OIDC `prompt`. Only `login` and `select_account` are satisfiable here — see below. */
  prompt: v.optional(v.string()),
  login_hint: v.optional(v.string()),
  /** Extension: skips the provider chooser and goes straight into the named provider. */
  provider: v.optional(v.string()),
})

/** Where the browser is sent to sign in: a configured front-end, or the built-in page. */
const loginTarget = (loginUrl: string | undefined, handle: string) => {
  if (!loginUrl) {
    return null
  }
  const url = new URL(loginUrl)
  url.searchParams.set('request', handle)
  return url.toString()
}

app.get(
  '/oauth/authorize',
  describeRoute({
    description:
      "The authorization endpoint (RFC 6749 §3.1, OpenID Connect Core §3.1.2.1). Validates the request, parks it, and puts the user in front of a sign-in screen; whichever provider they pick resumes this same request and redirects back to `redirect_uri` with a single-use `code`. Pass `provider=google` to skip the chooser. `prompt=none` is answered with `login_required`: this server keeps no session of its own, so it can never authenticate a user without interaction.",
    tags: ['OAuth'],
    responses: {
      200: { description: 'The built-in sign-in page' },
      302: { description: 'Redirect to the configured sign-in front-end, to a provider, or back to the client with `error`' },
      400: { description: 'Unknown client_id or unregistered redirect_uri' },
    },
  }),
  validator('query', authorizeSchema),
  async (c) => {
    const query = c.req.valid('query')
    const db = getDb(c.env)
    const context = getRequestContext(c)

    // Nothing may be reported through the redirect URI until both it and the client are known good:
    // until then an error redirect would be an open redirect, and the same hole an attacker would
    // use to have an authorization code delivered to themselves.
    const { application, redirectUri } = await resolveClient(db, query.client_id, query.redirect_uri)
    const state = query.state ?? null

    try {
      if (query.response_type !== RESPONSE_TYPE) {
        throw new OAuthException(
          400,
          'unsupported_response_type',
          `Only response_type=${RESPONSE_TYPE} is supported; the implicit and hybrid flows are not implemented`,
        )
      }
      assertGrantAllowed(application, 'authorization_code')
      const pkce = validatePkceParameters(application, query.code_challenge, query.code_challenge_method)
      const scope = normalizeScope(query.scope, application)

      // This server has no session of its own — every sign-in goes out to a provider — so there is
      // no state in which it could answer a request that forbids interaction.
      if (query.prompt === 'none') {
        throw new OAuthException(400, 'login_required', 'This authorization server cannot authenticate without interaction')
      }

      const { handle, record } = await createAuthorizationRequest(db, {
        application,
        redirectUri,
        state,
        nonce: query.nonce ?? null,
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: pkce.codeChallengeMethod,
        scope,
        prompt: query.prompt ?? null,
        loginHint: query.login_hint ?? null,
        ...context,
      })

      await recordAudit(db, {
        event: 'oauth.authorize.started',
        applicationId: application.id,
        ...context,
        metadata: { provider: query.provider ?? null, scope },
      })

      if (query.provider === 'google') {
        if (!googleProvider.isConfigured(c.env)) {
          throw new OAuthException(503, 'temporarily_unavailable', 'Google sign-in is not configured')
        }
        return c.redirect(
          await startGoogleFlow(db, c.env, {
            request: toAuthorizationRequest(record, application),
            loginHint: record.loginHint,
            ...context,
          }),
          302,
        )
      }

      const target = loginTarget(c.env.AUTH_LOGIN_URL, handle)
      if (target) {
        return c.redirect(target, 302)
      }

      return c.html(
        renderLoginPage({
          env: c.env,
          handle,
          applicationName: application.name,
          providers: getAvailableProviders(c.env),
          loginHint: query.login_hint ?? null,
        }),
      )
    } catch (error) {
      // Past `resolveClient` the redirect URI is trusted, so a failure is the client's to handle.
      if (error instanceof OAuthException) {
        return c.redirect(buildErrorRedirect(redirectUri, error.code, error.description, state), 302)
      }
      throw error
    }
  },
)

const pendingRequestSchema = v.object({
  code: v.literal(200),
  data: v.object({
    request: v.string(),
    client_id: v.string(),
    client_name: v.string(),
    scope: v.nullable(v.string()),
    login_hint: v.nullable(v.string()),
    expires_at: v.string(),
    providers: v.array(
      v.object({
        name: v.string(),
        display_name: v.string(),
        initiation: v.string(),
        start_url: v.string(),
      }),
    ),
  }),
})

app.get(
  '/oauth/authorize/:handle',
  describeRoute({
    description:
      'Describes a parked authorization request. This is what a sign-in front-end configured through `AUTH_LOGIN_URL` reads to know which application the user is signing in to and which providers it may offer. It deliberately exposes nothing about the request that the browser holding the handle did not already send.',
    tags: ['OAuth'],
    responses: {
      200: {
        description: 'The pending request',
        content: { 'application/json': { schema: resolver(pendingRequestSchema) } },
      },
      400: { description: 'The handle is unknown or expired' },
    },
  }),
  async (c) => {
    const handle = c.req.param('handle')
    const db = getDb(c.env)
    const { record, application } = await loadAuthorizationRequest(db, handle)

    const base = `${c.env.AUTH_PUBLIC_URL}/oauth/authorize/${encodeURIComponent(handle)}`
    return c.json({
      code: 200,
      data: {
        request: handle,
        client_id: application.id,
        client_name: application.name,
        scope: record.scope,
        login_hint: record.loginHint,
        expires_at: record.expiresAt.toISOString(),
        providers: getAvailableProviders(c.env).map((provider) => ({
          name: provider.name,
          display_name: provider.displayName,
          initiation: provider.initiation,
          start_url: `${base}/${provider.name.replace(/_/g, '-')}`,
        })),
      },
    })
  },
)

app.get(
  '/oauth/authorize/:handle/google',
  describeRoute({
    description: 'Continues a parked authorization request through Google, by redirecting the browser to Google.',
    tags: ['OAuth'],
    responses: {
      302: { description: "Redirect to Google's authorization endpoint" },
      400: { description: 'The handle is unknown or expired' },
      503: { description: 'Google sign-in is not configured on this deployment' },
    },
  }),
  async (c) => {
    if (!googleProvider.isConfigured(c.env)) {
      throw new OAuthException(503, 'temporarily_unavailable', 'Google sign-in is not configured')
    }

    const db = getDb(c.env)
    const context = getRequestContext(c)
    const { record, application } = await loadAuthorizationRequest(db, c.req.param('handle'))

    return c.redirect(
      await startGoogleFlow(db, c.env, {
        request: toAuthorizationRequest(record, application),
        loginHint: record.loginHint,
        ...context,
      }),
      302,
    )
  },
)

const magicLinkFormSchema = v.object({
  email: v.pipe(v.string(), v.trim(), v.email('A valid email address is required')),
})

const magicLinkResponseSchema = v.object({
  code: v.literal(202),
  data: v.object({ message: v.string(), expires_in: v.number() }),
})

/** The one message this endpoint gives out, whatever actually happened — see the note below. */
const MAGIC_LINK_NOTICE = 'If this address can sign in, a link is on its way. It is valid once, for 15 minutes.'

app.post(
  '/oauth/authorize/:handle/magic-link',
  describeRoute({
    description:
      'Continues a parked authorization request by emailing a magic link. Accepts either a form post (from the built-in sign-in page, answered with HTML) or JSON (from a custom front-end, answered with JSON). Like `POST /magic-link`, it always reports the same thing regardless of whether the address can actually sign in.',
    tags: ['OAuth'],
    responses: {
      200: { description: 'The built-in sign-in page, confirming the link was requested' },
      202: {
        description: 'The request was accepted',
        content: { 'application/json': { schema: resolver(magicLinkResponseSchema) } },
      },
      400: { description: 'The handle is unknown or expired, or the address is not an email address' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const context = getRequestContext(c)
    const { record, application } = await loadAuthorizationRequest(db, c.req.param('handle'))

    const contentType = c.req.header('Content-Type') ?? ''
    const isForm = contentType.includes('form-urlencoded') || contentType.includes('multipart/form-data')
    const payload = isForm ? await c.req.parseBody() : await c.req.json().catch(() => ({}))
    const parsed = v.safeParse(magicLinkFormSchema, { email: payload.email })

    const renderForm = (error: string | null, notice: string | null) =>
      c.html(
        renderLoginPage({
          env: c.env,
          handle: c.req.param('handle'),
          applicationName: application.name,
          providers: getAvailableProviders(c.env),
          loginHint: typeof payload.email === 'string' ? payload.email : record.loginHint,
          error,
          notice,
        }),
        error ? 400 : 200,
      )

    if (!parsed.success) {
      const message = parsed.issues[0]?.message ?? 'A valid email address is required'
      return isForm ? renderForm(message, null) : c.json({ code: 400, error: message }, 400)
    }

    const result = await requestMagicLink(db, c.env, {
      email: parsed.output.email,
      request: toAuthorizationRequest(record, application),
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
      // Whether an address resolved to an account stays out of the response; the audit row is the
      // only place it is recorded, which is what keeps this endpoint from being an oracle.
      metadata: { email: parsed.output.email, sent: result.sent },
    })

    if (isForm) {
      return renderForm(null, MAGIC_LINK_NOTICE)
    }
    return c.json({ code: 202, data: { message: MAGIC_LINK_NOTICE, expires_in: TTL.magicLink } }, 202)
  },
)

export default app
