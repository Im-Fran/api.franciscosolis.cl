import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import * as v from 'valibot'
import type { AppEnv } from '@/env'
import { CODE_CHALLENGE_METHOD } from '@/lib/config'
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

const metadataResponseSchema = v.object({
  issuer: v.string(),
  authorization_endpoint: v.string(),
  token_endpoint: v.string(),
  revocation_endpoint: v.string(),
  jwks_uri: v.string(),
  grant_types_supported: v.array(v.string()),
  response_types_supported: v.array(v.string()),
  code_challenge_methods_supported: v.array(v.string()),
  token_endpoint_auth_methods_supported: v.array(v.string()),
  scopes_supported: v.array(v.string()),
  id_token_signing_alg_values_supported: v.array(v.string()),
})

app.get(
  '/.well-known/oauth-authorization-server',
  describeRoute({
    description:
      'OAuth 2.0 Authorization Server Metadata (RFC 8414). Describes the endpoints and capabilities of this service. Note that `authorization_endpoint` only covers the redirect-based Google flow — the magic link provider is started with a POST to /magic-link instead.',
    tags: ['Discovery'],
    responses: {
      200: {
        description: 'Authorization server metadata',
        content: { 'application/json': { schema: resolver(metadataResponseSchema) } },
      },
    },
  }),
  (c) => {
    const base = c.env.AUTH_PUBLIC_URL
    c.header('Cache-Control', 'public, max-age=3600')
    return c.json({
      issuer: c.env.AUTH_ISSUER,
      authorization_endpoint: `${base}/oauth/google/authorize`,
      token_endpoint: `${base}/oauth/token`,
      revocation_endpoint: `${base}/oauth/revoke`,
      jwks_uri: `${base}/.well-known/jwks.json`,
      grant_types_supported: ['authorization_code', 'refresh_token'],
      response_types_supported: ['code'],
      code_challenge_methods_supported: [CODE_CHALLENGE_METHOD],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      scopes_supported: [...SUPPORTED_SCOPES],
      id_token_signing_alg_values_supported: ['EdDSA'],
    })
  },
)

export default app
