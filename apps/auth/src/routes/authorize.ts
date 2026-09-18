import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { AppEnv } from '@/env'
import { CODE_CHALLENGE_METHOD, DEFAULT_LOGIN_URL, PROMPT_VALUES, RESPONSE_TYPE, TTL } from '@/lib/config'
import { buildErrorRedirect, OAuthException } from '@/lib/errors'
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
import { authorizeFromSsoSession, startGoogleFlow } from '@/services/authorization'
import { getSsoSessionById, readSsoSession } from '@/services/sso'
import type { ResolvedSsoSession } from '@/services/sso'

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
  /** OIDC `prompt`, a space-delimited set. All four values are satisfiable — see `PROMPT_VALUES`. */
  prompt: v.optional(v.string()),
  /** OIDC `max_age`: how old, in seconds, the user's authentication may be for this request. */
  max_age: v.optional(v.string()),
  login_hint: v.optional(v.string()),
  /** Extension: skips the provider chooser and goes straight into the named provider. */
  provider: v.optional(v.string()),
})

/**
 * Where the browser is sent to sign in, with the parked request's handle appended.
 *
 * This Worker answers nothing but JSON and redirects, so the one step of an OAuth flow that has to
 * show the user something belongs to a front-end. `AUTH_LOGIN_URL` names it and `DEFAULT_LOGIN_URL`
 * is where it lives on this deployment; a value that is not a URL falls back to the default rather
 * than taking sign-in down, because there is no page here to fail over to any more.
 */
const loginTarget = (loginUrl: string | undefined, handle: string) => {
  let url: URL
  try {
    url = new URL(loginUrl || DEFAULT_LOGIN_URL)
  } catch {
    url = new URL(DEFAULT_LOGIN_URL)
  }
  url.searchParams.set('request', handle)
  return url.toString()
}

/**
 * `prompt` as the set it is. OIDC Core §3.1.2.1 defines it as space-delimited, and `none` is
 * defined to be mutually exclusive with everything else — a request asking both to skip and to
 * force interaction has no reading, so it is refused rather than resolved in someone's favour.
 */
const parsePrompt = (prompt: string | undefined) => {
  const values = new Set((prompt ?? '').split(/\s+/).filter(Boolean))
  for (const value of values) {
    if (!(PROMPT_VALUES as readonly string[]).includes(value)) {
      throw new OAuthException(400, 'invalid_request', `Unsupported prompt value: ${value}`)
    }
  }
  if (values.has('none') && values.size > 1) {
    throw new OAuthException(400, 'invalid_request', 'prompt=none cannot be combined with another prompt value')
  }
  return values
}

/** `max_age` in seconds, or null when the client did not ask. Anything else is a bad request. */
const parseMaxAge = (maxAge: string | undefined) => {
  if (maxAge === undefined) {
    return null
  }
  if (!/^\d+$/.test(maxAge)) {
    throw new OAuthException(400, 'invalid_request', 'max_age must be a non-negative number of seconds')
  }
  return Number(maxAge)
}

/**
 * Whether an SSO session still satisfies what the client asked for.
 *
 * `prompt=login` and `prompt=select_account` both mean "authenticate again", and `max_age` means
 * "not if it was longer ago than this" — measured from `authenticated_at`, which a reuse never
 * moves, so a client asking for a recent authentication gets one rather than a session that has
 * merely been busy.
 */
const isSsoSessionAcceptable = (
  session: ResolvedSsoSession | null,
  prompts: Set<string>,
  maxAge: number | null,
): session is ResolvedSsoSession => {
  if (!session) {
    return false
  }
  if (prompts.has('login') || prompts.has('select_account')) {
    return false
  }
  if (maxAge !== null) {
    return Date.now() - session.session.authenticatedAt.getTime() <= maxAge * 1000
  }
  return true
}

app.get(
  '/oauth/authorize',
  describeRoute({
    description:
      'The authorization endpoint (RFC 6749 §3.1, OpenID Connect Core §3.1.2.1). Validates the request, parks it, and redirects the browser to the sign-in front-end (`AUTH_LOGIN_URL`) with the parked handle as `?request=`; whichever provider the user picks there resumes this same request and redirects back to `redirect_uri` with a single-use `code`. A browser that already holds an SSO session with this server carries it on the parked request, so the front-end offers to authorize the application instead of asking for a sign-in, and `prompt=none` is answered straight away with a code. `prompt=login`/`select_account` and an exceeded `max_age` force a fresh authentication; `prompt=none` without a usable session is still `login_required`. Pass `provider=google` to skip the front-end and go straight to Google.',
    tags: ['OAuth'],
    responses: {
      302: { description: 'Redirect to the sign-in front-end, to a provider, or back to the client with `error`' },
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

      const prompts = parsePrompt(query.prompt)
      const maxAge = parseMaxAge(query.max_age)

      // The cookie is the only thing that says this browser is signed in. It arrives because this
      // endpoint is navigated to, which is also why the front-end cannot read it: it calls this
      // Worker cross-origin with `fetch`, where no cookie is sent. Hence the stamp on the parked
      // row below.
      const sso = await readSsoSession(c, db)
      const authenticated = isSsoSessionAcceptable(sso, prompts, maxAge) ? sso : null

      // `prompt=none` forbids interaction, so there is nothing to park and nobody to show a screen
      // to: either this browser is already signed in, or the client is told so.
      if (prompts.has('none')) {
        if (!authenticated) {
          throw new OAuthException(
            400,
            'login_required',
            'No active session satisfies this request; the user has to authenticate',
          )
        }

        await recordAudit(db, {
          event: 'oauth.authorize.started',
          applicationId: application.id,
          ...context,
          metadata: { provider: authenticated.session.provider, scope, prompt: 'none' },
        })

        const { redirectUrl } = await authorizeFromSsoSession(c, db, {
          request: {
            application,
            redirectUri,
            state,
            nonce: query.nonce ?? null,
            codeChallenge: pkce.codeChallenge,
            codeChallengeMethod: pkce.codeChallengeMethod,
            scope,
          },
          session: authenticated.session,
          user: authenticated.user,
          ...context,
        })
        return c.redirect(redirectUrl, 302)
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
        ssoSessionId: authenticated?.session.id ?? null,
        ...context,
      })

      await recordAudit(db, {
        event: 'oauth.authorize.started',
        applicationId: application.id,
        ...context,
        metadata: { provider: query.provider ?? null, scope, authenticated: authenticated !== null },
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

      return c.redirect(loginTarget(c.env.AUTH_LOGIN_URL, handle), 302)
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
    /** Who this browser is already signed in as, or null when it has to authenticate. */
    authenticated: v.nullable(
      v.object({
        sub: v.string(),
        email: v.string(),
        name: v.nullable(v.string()),
        picture: v.nullable(v.string()),
        auth_time: v.string(),
        continue_url: v.string(),
      }),
    ),
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
      'Describes a parked authorization request. This is what a sign-in front-end configured through `AUTH_LOGIN_URL` reads to know which application the user is signing in to and which providers it may offer. When the browser that started the request was already signed in, `authenticated` names the account and carries the `continue_url` an "Authorize" button navigates to; otherwise it is null and the providers are the only way on. It deliberately exposes nothing else about the request that the browser holding the handle did not already send.',
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

    // Read off the row rather than off a cookie: the front-end calls this cross-origin with
    // `fetch`, which carries none. That is a hint and not an authority — the handle is enough to
    // learn who the browser that started this request was signed in as, and nothing more:
    // `/continue` asks for the cookie again before it mints anything.
    const sso = record.ssoSessionId ? await getSsoSessionById(db, record.ssoSessionId) : null

    return c.json({
      code: 200,
      data: {
        request: handle,
        client_id: application.id,
        client_name: application.name,
        scope: record.scope,
        login_hint: record.loginHint,
        expires_at: record.expiresAt.toISOString(),
        authenticated: sso
          ? {
              sub: sso.user.id,
              email: sso.user.email,
              name: sso.user.name,
              picture: sso.user.picture,
              auth_time: sso.session.authenticatedAt.toISOString(),
              continue_url: `${base}/continue`,
            }
          : null,
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
  '/oauth/authorize/:handle/continue',
  describeRoute({
    description:
      'Completes a parked authorization request from the SSO session the browser already holds — the "Authorize" button of the sign-in front-end, which navigates here rather than calling it with `fetch`. The session cookie is what authorizes this, not the handle: a browser without it, or with one naming a different session than the one that started the request, is sent to the sign-in front-end to authenticate instead. Answers with the same redirect back to the client as a fresh sign-in, carrying a single-use `code`.',
    tags: ['OAuth'],
    responses: {
      302: { description: 'Redirect to the client with `code`, or back to the sign-in front-end' },
      400: { description: 'The handle is unknown or expired' },
    },
  }),
  async (c) => {
    const handle = c.req.param('handle')
    const db = getDb(c.env)
    const context = getRequestContext(c)
    const { record, application } = await loadAuthorizationRequest(db, handle)

    const sso = await readSsoSession(c, db)

    // The stamp on the row is only a hint for the front-end; the cookie is the authority. A session
    // that ended, or one belonging to a browser other than the one that parked this request, is not
    // an error — it is somebody who has to sign in, so they are sent back to do exactly that.
    if (!sso || (record.ssoSessionId && record.ssoSessionId !== sso.session.id)) {
      return c.redirect(loginTarget(c.env.AUTH_LOGIN_URL, handle), 302)
    }

    try {
      const { redirectUrl } = await authorizeFromSsoSession(c, db, {
        request: toAuthorizationRequest(record, application),
        session: sso.session,
        user: sso.user,
        ...context,
      })
      return c.redirect(redirectUrl, 302)
    } catch (error) {
      // The redirect URI was validated when the request was parked, so a failure past this point is
      // the client's to handle rather than a dead end for the user.
      if (error instanceof OAuthException) {
        return c.redirect(buildErrorRedirect(record.redirectUri, error.code, error.description, record.state), 302)
      }
      throw error
    }
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

const magicLinkBodySchema = v.object({
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
      'Continues a parked authorization request by emailing a magic link. This is what the sign-in front-end calls when the user submits their address. Like `POST /magic-link`, it always reports the same thing regardless of whether the address can actually sign in.',
    tags: ['OAuth'],
    responses: {
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

    const payload = await c.req.json().catch(() => ({}))
    const parsed = v.safeParse(magicLinkBodySchema, { email: payload.email })

    if (!parsed.success) {
      const message = parsed.issues[0]?.message ?? 'A valid email address is required'
      return c.json({ code: 400, error: message }, 400)
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

    return c.json({ code: 202, data: { message: MAGIC_LINK_NOTICE, expires_in: TTL.magicLink } }, 202)
  },
)

export default app
