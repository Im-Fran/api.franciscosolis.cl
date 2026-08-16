import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

/** Error codes defined by RFC 6749 §5.2 / §4.1.2.1 that this Worker can return. */
type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'access_denied'
  | 'server_error'
  | 'temporarily_unavailable'

/**
 * An error that must be rendered in the OAuth 2.0 shape (`{ error, error_description }`) rather
 * than this monorepo's usual `{ code, error }`, because token-endpoint clients parse the former.
 * `app.onError` checks for this type and serialises it accordingly.
 */
class OAuthException extends HTTPException {
  readonly code: OAuthErrorCode
  readonly description: string

  constructor(status: ContentfulStatusCode, code: OAuthErrorCode, description: string) {
    super(status, { message: description })
    this.code = code
    this.description = description
  }
}

/**
 * Signals that a redirect-based flow failed before a redirect URI could be trusted, so the error
 * has to be shown to the user instead of being handed back to the client application.
 */
class RedirectValidationException extends HTTPException {
  constructor(message: string) {
    super(400, { message })
  }
}

/** Appends OAuth error parameters to an already validated redirect URI (RFC 6749 §4.1.2.1). */
const buildErrorRedirect = (redirectUri: string, code: OAuthErrorCode, description: string, state?: string | null) => {
  const url = new URL(redirectUri)
  url.searchParams.set('error', code)
  url.searchParams.set('error_description', description)
  if (state) {
    url.searchParams.set('state', state)
  }
  return url.toString()
}

export { buildErrorRedirect, OAuthException, RedirectValidationException }
export type { OAuthErrorCode }
