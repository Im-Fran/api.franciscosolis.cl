import axios from 'axios'
import type { Env } from '@/env'
import { OAuthException } from '@/lib/errors'

/** Cloudflare's server-side verification endpoint (Turnstile "siteverify"). */
const TURNSTILE_VERIFY_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** How long to wait for Cloudflare before treating the verification as failed. */
const TURNSTILE_TIMEOUT_MS = 5_000

/**
 * Shape of the siteverify answer. `error-codes` is documented and is logged rather than returned:
 * telling a caller *why* their token was refused tells a script how to fix it.
 */
type SiteVerifyResponse = {
  success: boolean
  'error-codes'?: string[]
  challenge_ts?: string
  hostname?: string
  action?: string
}

/**
 * Whether this deployment challenges bots at all.
 *
 * Both halves have to be present: the secret is what verifies a token, and the site key is what the
 * sign-in front-end needs to render a widget in the first place. A deployment holding neither — a
 * local run, the test suite — skips the check entirely rather than refusing every sign-in, which is
 * the same shape `googleProvider.isConfigured` uses for a provider whose secrets are not set.
 */
const isTurnstileConfigured = (env: Env) => Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY)

/** What the sign-in front-end is told: the site key when it is configured, and nothing otherwise. */
const describeTurnstile = (env: Env) => ({
  required: isTurnstileConfigured(env),
  site_key: isTurnstileConfigured(env) ? (env.TURNSTILE_SITE_KEY as string) : null,
})

/**
 * Verifies a Turnstile token against Cloudflare and throws when it does not hold up.
 *
 * Three things here are deliberate:
 *
 * - **A deployment with no keys does not challenge.** The check is skipped, not failed, so a local
 *   Worker and the test suite behave like the deployment did before Turnstile existed.
 * - **An unreachable Cloudflare is a refusal, not a pass.** This guards an endpoint that sends mail
 *   and, with registration open, creates accounts; failing open would mean an outage at Cloudflare
 *   is all it takes to point a script at it. The failure is `temporarily_unavailable`, which says
 *   what it is, and the verification is one call to an endpoint on the same network as the Worker.
 * - **A token is single-use at Cloudflare's end.** Re-submitting one that was already spent comes
 *   back `timeout-or-duplicate`, so a replayed request is refused by the same code path as a forged
 *   one and nothing here has to keep a list of spent tokens.
 */
const verifyTurnstile = async (
  env: Env,
  token: string | undefined | null,
  remoteIp: string | null,
): Promise<void> => {
  if (!isTurnstileConfigured(env)) {
    return
  }

  if (!token) {
    throw new OAuthException(400, 'invalid_request', 'A Turnstile token is required')
  }

  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY as string, response: token })
  if (remoteIp) {
    body.set('remoteip', remoteIp)
  }

  let result: SiteVerifyResponse
  try {
    const response = await axios.post<SiteVerifyResponse>(TURNSTILE_VERIFY_ENDPOINT, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: TURNSTILE_TIMEOUT_MS,
    })
    result = response.data
  } catch (error) {
    console.error('turnstile verification unreachable', error)
    throw new OAuthException(503, 'temporarily_unavailable', 'The bot check could not be completed; please try again')
  }

  if (!result?.success) {
    // Logged, never returned: the error codes say precisely what was wrong with the token.
    console.warn('turnstile verification failed', result?.['error-codes'] ?? [])
    throw new OAuthException(400, 'access_denied', 'The bot check did not pass; please try again')
  }
}

export { describeTurnstile, isTurnstileConfigured, TURNSTILE_VERIFY_ENDPOINT, verifyTurnstile }
export type { SiteVerifyResponse }
