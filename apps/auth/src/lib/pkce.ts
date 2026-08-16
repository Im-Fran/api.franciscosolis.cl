import { CODE_CHALLENGE_METHOD } from '@/lib/config'
import { base64UrlEncode, randomToken, timingSafeEqual } from '@/lib/crypto'

/** RFC 7636 §4.2: challenge = BASE64URL(SHA256(ASCII(code_verifier))). */
const deriveChallenge = async (codeVerifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  return base64UrlEncode(digest)
}

/**
 * Creates the verifier/challenge pair this Worker uses for its *own* PKCE-protected request to an
 * upstream provider (Google). Client applications generate their own pair; this is the other leg.
 */
const createPkcePair = async () => {
  const codeVerifier = randomToken(32)
  return { codeVerifier, codeChallenge: await deriveChallenge(codeVerifier) }
}

/**
 * Checks a verifier against the challenge recorded when the flow started. Only S256 is supported:
 * `plain` would let anyone who intercepts the authorization request replay it.
 */
const verifyPkce = async (codeVerifier: string, codeChallenge: string, method: string): Promise<boolean> => {
  if (method !== CODE_CHALLENGE_METHOD) {
    return false
  }
  return timingSafeEqual(await deriveChallenge(codeVerifier), codeChallenge)
}

/** RFC 7636 §4.1 requires a verifier of 43–128 characters from an unreserved-character alphabet. */
const isValidCodeVerifier = (codeVerifier: string): boolean => /^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)

export { createPkcePair, deriveChallenge, isValidCodeVerifier, verifyPkce }
