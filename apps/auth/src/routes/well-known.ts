import { Hono } from 'hono'
import type { Context } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import * as v from 'valibot'
import type { AppEnv } from '@/env'
import { CLIENT_AUTH_METHODS, CODE_CHALLENGE_METHOD, GRANT_TYPES, RESPONSE_TYPE } from '@/lib/config'
import { getPublicJwks } from '@/lib/jwt'
import { SUPPORTED_SCOPES } from '@/services/applications'

const app = new Hono<AppEnv>()

const jwksResponseSchema = v.object({
  keys: v.array(
    v.object({
      kty: v.string(),
      crv: v.string(),
      alg: v.string(),
      kid: v.string(),
      use: v.optional(v.string()),
      key_ops: v.optional(v.array(v.string())),
      x: v.string(),
    }),
  ),
})

app.get(
  '/.well-known/jwks.json',
  describeRoute({
    description:
      'Public keys that verify the access tokens issued by this service. Any Worker or backend can validate a token offline against these keys, without calling the auth service.',
    tags: ['Discovery'],
    responses: {
      200: {
        description: 'JSON Web Key Set',
        content: { 'application/json': { schema: resolver(jwksResponseSchema) } },
      },
    },
  }),
  (c) => {
    // Public keys are immutable per `kid`, so a long cache is safe; a rotation adds a new key
    // rather than changing an existing one, and retired keys stay published until their last
    // access token has expired.
    c.header('Cache-Control', 'public, max-age=3600')
    return c.json({ keys: getPublicJwks(c.env) })
  },
)

const metadataResponseSchema = v.looseObject({
  issuer: v.string(),
  authorization_endpoint: v.string(),
  token_endpoint: v.string(),
  userinfo_endpoint: v.string(),
  revocation_endpoint: v.string(),
  introspection_endpoint: v.string(),
  end_session_endpoint: v.string(),
  jwks_uri: v.string(),
  grant_types_supported: v.array(v.string()),
  response_types_supported: v.array(v.string()),
  code_challenge_methods_supported: v.array(v.string()),
  token_endpoint_auth_methods_supported: v.array(v.string()),
  scopes_supported: v.array(v.string()),
  id_token_signing_alg_values_supported: v.array(v.string()),
})

/**
 * The metadata document, shared by both discovery URLs.
 *
 * RFC 8414 and OpenID Connect Discovery describe the same server with two names and two overlapping
 * field sets, so it is built once here and published twice: a relying party that only knows one of
 * the two spellings must not see a different server than one that knows the other.
 */
const buildMetadata = (env: { AUTH_ISSUER: string; AUTH_PUBLIC_URL: string }) => {
  const base = env.AUTH_PUBLIC_URL
  return {
    issuer: env.AUTH_ISSUER,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    userinfo_endpoint: `${base}/oauth/userinfo`,
    revocation_endpoint: `${base}/oauth/revoke`,
    introspection_endpoint: `${base}/oauth/introspect`,
    end_session_endpoint: `${base}/oauth/logout`,
    jwks_uri: `${base}/.well-known/jwks.json`,
    grant_types_supported: [...GRANT_TYPES],
    response_types_supported: [RESPONSE_TYPE],
    response_modes_supported: ['query'],
    subject_types_supported: ['public'],
    code_challenge_methods_supported: [CODE_CHALLENGE_METHOD],
    token_endpoint_auth_methods_supported: [...CLIENT_AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...CLIENT_AUTH_METHODS],
    introspection_endpoint_auth_methods_supported: [...CLIENT_AUTH_METHODS],
    scopes_supported: [...SUPPORTED_SCOPES],
    claims_supported: [
      'iss',
      'sub',
      'aud',
      'exp',
      'iat',
      'auth_time',
      'nonce',
      'at_hash',
      'azp',
      'sid',
      'email',
      'email_verified',
      'name',
      'given_name',
      'family_name',
      'picture',
      'locale',
      'roles',
      'groups',
      'permissions',
    ],
    id_token_signing_alg_values_supported: ['EdDSA'],
    // Every registered client is first-party, so nobody is ever asked to approve a scope.
    require_pushed_authorization_requests: false,
    claims_parameter_supported: false,
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
  }
}

const discovery = describeRoute({
  description:
    'Metadata describing this authorization server: its endpoints, the grants, scopes and client authentication methods it accepts, and the algorithm its tokens are signed with. Published at both well-known URLs — RFC 8414 for OAuth 2.0 clients and OpenID Connect Discovery for OIDC relying parties — with identical content. This is the single document to point a relying party (Cloudflare Access among them) at.',
  tags: ['Discovery'],
  responses: {
    200: {
      description: 'Authorization server metadata',
      content: { 'application/json': { schema: resolver(metadataResponseSchema) } },
    },
  },
})

const serveMetadata = (c: Context<AppEnv>) => {
  c.header('Cache-Control', 'public, max-age=3600')
  return c.json(buildMetadata(c.env))
}

app.get('/.well-known/oauth-authorization-server', discovery, (c) => serveMetadata(c))
app.get('/.well-known/openid-configuration', discovery, (c) => serveMetadata(c))

export default app
export { buildMetadata }
