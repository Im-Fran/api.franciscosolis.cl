import type { Env } from '@/env'
import type { ProviderName } from '@/lib/config'
import type { Application } from '@/services/applications'

/**
 * What every provider must produce, and the only thing the rest of the Worker knows about them.
 *
 * `emailVerified` is not decoration: `resolveUserForProfile` refuses to link an identity to an
 * existing account unless the provider actually proved ownership of the address, because that link
 * is what lets one provider vouch for a user another provider created.
 */
type ProviderProfile = {
  provider: ProviderName
  /** Stable, provider-local identifier. Google's OIDC `sub`; the address itself for magic links. */
  providerAccountId: string
  email: string
  emailVerified: boolean
  name?: string | null
  givenName?: string | null
  familyName?: string | null
  picture?: string | null
  locale?: string | null
  /** Raw provider payload, stored on the identity row for debugging and future backfills. */
  raw?: unknown
}

/**
 * A validated authorization request: the client, where to send the user back, and the PKCE
 * challenge that will have to be answered at the token endpoint. Providers carry this across their
 * own round trip (an email, or a redirect to Google) and hand it back untouched when the user
 * returns, so the destination is fixed at the moment the flow starts, not when it finishes.
 */
type AuthorizationRequest = {
  application: Application
  redirectUri: string
  state: string | null
  codeChallenge: string
  codeChallengeMethod: string
  scope: string
}

/**
 * How a provider is started. `email` providers accept a POST and deliver a link out of band;
 * `redirect` providers send the browser to an external authorization server.
 */
type ProviderInitiation = 'email' | 'redirect'

type ProviderDescriptor = {
  name: ProviderName
  displayName: string
  initiation: ProviderInitiation
  /** Path, relative to `AUTH_PUBLIC_URL`, where the flow begins. */
  startPath: string
  /** Whether the secrets this provider needs are actually present in the environment. */
  isConfigured: (env: Env) => boolean
}

export type { AuthorizationRequest, ProviderDescriptor, ProviderInitiation, ProviderProfile }
