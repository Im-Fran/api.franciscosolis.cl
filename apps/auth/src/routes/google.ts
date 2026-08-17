import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { oauthStates } from '@/db/schema'
import type { AppEnv } from '@/env'
import { CODE_CHALLENGE_METHOD } from '@/lib/config'
import { sha256 } from '@/lib/crypto'
import { buildErrorRedirect, OAuthException, RedirectValidationException } from '@/lib/errors'
import { exchangeAuthorizationCode, googleProvider, verifyIdToken } from '@/providers/google'
import {
  assertGrantAllowed,
  getApplication,
  normalizeScope,
  resolveClient,
  validatePkceParameters,
} from '@/services/applications'
import { getRequestContext, recordAudit } from '@/services/audit'
import { completeAuthentication, startGoogleFlow } from '@/services/authorization'

const app = new Hono<AppEnv>()

const authorizeSchema = v.object({
  client_id: v.pipe(v.string(), v.minLength(1)),
  redirect_uri: v.pipe(v.string(), v.url('redirect_uri must be an absolute URL')),
  state: v.optional(v.string()),
  nonce: v.optional(v.string()),
  code_challenge: v.optional(v.string()),
  code_challenge_method: v.optional(v.literal(CODE_CHALLENGE_METHOD)),
  scope: v.optional(v.string()),
  login_hint: v.optional(v.string()),
})

app.get(
  '/oauth/google/authorize',
  describeRoute({
    description:
      "Starts a Google sign-in directly, skipping the provider chooser at `/oauth/authorize`. It takes the same parameters as that endpoint and behaves identically from Google's redirect onwards; `/oauth/authorize?provider=google` is the equivalent through the general entry point.",
    tags: ['Google'],
    responses: {
      302: { description: "Redirect to Google's authorization endpoint" },
      400: { description: 'Unknown client_id or unregistered redirect_uri' },
      503: { description: 'Google sign-in is not configured on this deployment' },
    },
  }),
  validator('query', authorizeSchema),
  async (c) => {
    if (!googleProvider.isConfigured(c.env)) {
      throw new OAuthException(503, 'temporarily_unavailable', 'Google sign-in is not configured')
    }

    const query = c.req.valid('query')
    const db = getDb(c.env)
    const context = getRequestContext(c)

    const { application, redirectUri } = await resolveClient(db, query.client_id, query.redirect_uri)

    // From here on the redirect URI is trusted, so failures are reported to the client application
    // in the redirect instead of being rendered to the user.
    try {
      assertGrantAllowed(application, 'authorization_code')
      const pkce = validatePkceParameters(application, query.code_challenge, query.code_challenge_method)
      const scope = normalizeScope(query.scope, application)

      return c.redirect(
        await startGoogleFlow(db, c.env, {
          request: {
            application,
            redirectUri,
            state: query.state ?? null,
            nonce: query.nonce ?? null,
            codeChallenge: pkce.codeChallenge,
            codeChallengeMethod: pkce.codeChallengeMethod,
            scope,
          },
          loginHint: query.login_hint ?? null,
          ...context,
        }),
        302,
      )
    } catch (error) {
      if (error instanceof OAuthException) {
        return c.redirect(buildErrorRedirect(redirectUri, error.code, error.description, query.state ?? null), 302)
      }
      throw error
    }
  },
)

const callbackSchema = v.object({
  state: v.pipe(v.string(), v.minLength(1)),
  code: v.optional(v.string()),
  error: v.optional(v.string()),
  error_description: v.optional(v.string()),
})

app.get(
  '/oauth/google/callback',
  describeRoute({
    description:
      "Handles Google's redirect: validates the state, exchanges the code for an ID token, verifies it against Google's JWKS, then redirects back to the client application with a single-use authorization code.",
    tags: ['Google'],
    responses: {
      302: { description: 'Redirect to the client application with `code` and `state`, or with `error`' },
      400: { description: 'The state is unknown, expired or already used' },
    },
  }),
  validator('query', callbackSchema),
  async (c) => {
    const query = c.req.valid('query')
    const db = getDb(c.env)
    const context = getRequestContext(c)

    const stateHash = await sha256(query.state)
    const [state] = await db.select().from(oauthStates).where(eq(oauthStates.stateHash, stateHash)).limit(1)

    if (!state) {
      throw new RedirectValidationException('Unknown sign-in state; please start again')
    }
    if (state.expiresAt.getTime() <= Date.now()) {
      throw new RedirectValidationException('This sign-in attempt expired; please start again')
    }

    // Single-use, same compare-and-swap as every other one-time token here: a replayed callback
    // finds the row already consumed and stops.
    const consumed = await db
      .update(oauthStates)
      .set({ consumedAt: new Date() })
      .where(and(eq(oauthStates.id, state.id), isNull(oauthStates.consumedAt)))
      .returning({ id: oauthStates.id })

    if (consumed.length === 0) {
      throw new RedirectValidationException('This sign-in attempt was already completed; please start again')
    }

    const failWithRedirect = async (code: Parameters<typeof buildErrorRedirect>[1], description: string) => {
      await recordAudit(db, {
        event: 'oauth.callback.rejected',
        applicationId: state.applicationId,
        ...context,
        metadata: { provider: 'google', reason: code },
      })
      return c.redirect(buildErrorRedirect(state.redirectUri, code, description, state.clientState), 302)
    }

    if (query.error) {
      return failWithRedirect('access_denied', query.error_description ?? query.error)
    }
    if (!query.code) {
      return failWithRedirect('invalid_request', 'Google did not return an authorization code')
    }

    const application = await getApplication(db, state.applicationId)
    if (!application) {
      throw new RedirectValidationException('The application this sign-in was started for is no longer available')
    }

    try {
      const tokens = await exchangeAuthorizationCode(c.env, {
        code: query.code,
        codeVerifier: state.providerCodeVerifier,
      })
      const profile = await verifyIdToken(c.env, tokens.id_token as string, state.nonce)

      const { redirectUrl } = await completeAuthentication(db, {
        request: {
          application,
          redirectUri: state.redirectUri,
          state: state.clientState,
          nonce: state.clientNonce,
          codeChallenge: state.codeChallenge,
          codeChallengeMethod: state.codeChallengeMethod,
          scope: state.scope ?? '',
        },
        profile,
        ...context,
      })

      return c.redirect(redirectUrl, 302)
    } catch (error) {
      if (error instanceof OAuthException) {
        return failWithRedirect(error.code, error.description)
      }
      throw error
    }
  },
)

export default app
