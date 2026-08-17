import { and, asc, eq } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { applications, applicationSecrets } from '@/db/schema'
import { CLIENT_AUTH_METHODS, CODE_CHALLENGE_METHOD, GRANT_TYPES } from '@/lib/config'
import type { ClientAuthMethod, GrantType } from '@/lib/config'
import { base64UrlDecode, generateId, randomToken, sha256, timingSafeEqual } from '@/lib/crypto'
import { OAuthException, RedirectValidationException } from '@/lib/errors'

type Application = typeof applications.$inferSelect
type ApplicationSecret = typeof applicationSecrets.$inferSelect

/**
 * Scopes this Worker understands. Anything else is rejected rather than silently dropped.
 *
 * `openid` turns the flow into OpenID Connect: it is what makes the token endpoint return an
 * `id_token`. `roles` and `groups` add the caller's role slugs to the id_token and to
 * `/oauth/userinfo` — `groups` under the name relying parties that do group-based access control
 * (Cloudflare Access among them) expect to find them under. `offline_access` is accepted for
 * clients that ask for it by habit; a refresh token is issued for the authorization code grant
 * whether or not it is requested.
 */
const SUPPORTED_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'roles', 'groups'] as const
type SupportedScope = (typeof SUPPORTED_SCOPES)[number]

const DEFAULT_SCOPE = 'openid profile email'

const getApplication = async (db: Database, clientId: string): Promise<Application | null> => {
  const [application] = await db
    .select()
    .from(applications)
    .where(and(eq(applications.id, clientId), eq(applications.isActive, true)))
    .limit(1)
  return application ?? null
}

/** Parses one of the JSON array columns, tolerating anything that is not a list of strings. */
const parseStringList = (raw: string): string[] => {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

const getRedirectUris = (application: Application): string[] => parseStringList(application.redirectUris)

const getPostLogoutRedirectUris = (application: Application): string[] =>
  parseStringList(application.postLogoutRedirectUris)

const getAllowedOrigins = (application: Application): string[] => parseStringList(application.allowedOrigins)

const getGrantTypes = (application: Application): GrantType[] =>
  parseStringList(application.grantTypes).filter((entry): entry is GrantType =>
    GRANT_TYPES.includes(entry as GrantType),
  )

/** An empty list means "every supported scope", which is what a client gets unless narrowed. */
const getAllowedScopes = (application: Application): readonly string[] => {
  const configured = parseStringList(application.scopes)
  return configured.length === 0 ? SUPPORTED_SCOPES : configured
}

const getClientAuthMethod = (application: Application): ClientAuthMethod =>
  CLIENT_AUTH_METHODS.includes(application.tokenEndpointAuthMethod as ClientAuthMethod)
    ? (application.tokenEndpointAuthMethod as ClientAuthMethod)
    : 'none'

/** A confidential client is one that authenticates with a secret; the rest are public. */
const isConfidential = (application: Application): boolean => getClientAuthMethod(application) !== 'none'

/**
 * Resolves the client and its redirect URI together, because until BOTH are known good there is
 * nowhere safe to send an error: redirecting to an unverified URI is an open redirect, and it is
 * also how an attacker would exfiltrate an authorization code. Failures here are rendered to the
 * user instead.
 */
const resolveClient = async (db: Database, clientId: string, redirectUri: string) => {
  const application = await getApplication(db, clientId)
  if (!application) {
    throw new RedirectValidationException('Unknown or inactive client_id')
  }

  // Exact string match, per OAuth 2.0 Security BCP: no prefix or wildcard matching, which would
  // let an open redirect or a path traversal on the client's own domain capture the code.
  if (!getRedirectUris(application).includes(redirectUri)) {
    throw new RedirectValidationException('redirect_uri is not registered for this client')
  }

  return { application, redirectUri }
}

type PkceParameters = {
  codeChallenge: string | null
  codeChallengeMethod: string | null
}

/**
 * Validates the PKCE parameters of an authorization request.
 *
 * PKCE is mandatory unless the client is confidential AND has `require_pkce` turned off. That
 * escape hatch exists for relying parties that never implemented RFC 7636 and cannot be changed —
 * Cloudflare Access is the one this was built for — and it is only sound because such a client
 * authenticates with a secret at the token endpoint, which is the binding PKCE would otherwise
 * provide. A public client can never opt out: nothing else would tie the code to its requester.
 */
const validatePkceParameters = (
  application: Application,
  codeChallenge: string | undefined,
  codeChallengeMethod: string | undefined,
): PkceParameters => {
  if (!codeChallenge) {
    if (application.requirePkce || !isConfidential(application)) {
      throw new OAuthException(400, 'invalid_request', 'code_challenge is required for this client')
    }
    if (codeChallengeMethod) {
      throw new OAuthException(400, 'invalid_request', 'code_challenge_method was sent without a code_challenge')
    }
    return { codeChallenge: null, codeChallengeMethod: null }
  }

  const method = codeChallengeMethod ?? CODE_CHALLENGE_METHOD
  if (method !== CODE_CHALLENGE_METHOD) {
    throw new OAuthException(400, 'invalid_request', `code_challenge_method must be ${CODE_CHALLENGE_METHOD}`)
  }
  // A base64url-encoded SHA-256 digest is always 43 characters with padding stripped.
  if (!/^[A-Za-z0-9\-_]{43}$/.test(codeChallenge)) {
    throw new OAuthException(400, 'invalid_request', 'code_challenge must be a base64url-encoded SHA-256 digest')
  }
  return { codeChallenge, codeChallengeMethod: method }
}

/**
 * Narrows a requested scope to what this server implements and what the client is allowed to ask
 * for. An unsupported or un-granted scope is an error rather than a silent removal, so a client
 * never believes it holds a permission the token does not carry.
 */
const normalizeScope = (scope: string | undefined | null, application?: Application): string => {
  const allowed = application ? getAllowedScopes(application) : SUPPORTED_SCOPES

  if (!scope) {
    const fallback = DEFAULT_SCOPE.split(' ').filter((entry) => allowed.includes(entry))
    return fallback.join(' ')
  }

  const requested = scope.split(/\s+/).filter(Boolean)
  const unsupported = requested.filter((entry) => !SUPPORTED_SCOPES.includes(entry as SupportedScope))
  if (unsupported.length > 0) {
    throw new OAuthException(400, 'invalid_scope', `Unsupported scope: ${unsupported.join(', ')}`)
  }
  const refused = requested.filter((entry) => !allowed.includes(entry))
  if (refused.length > 0) {
    throw new OAuthException(400, 'invalid_scope', `This client may not request: ${refused.join(', ')}`)
  }
  return [...new Set(requested)].join(' ')
}

const hasScope = (scope: string | null | undefined, entry: SupportedScope): boolean =>
  (scope ?? '').split(/\s+/).includes(entry)

/** Refuses a grant the client is not registered for (RFC 6749 §5.2 `unauthorized_client`). */
const assertGrantAllowed = (application: Application, grantType: GrantType) => {
  if (!getGrantTypes(application).includes(grantType)) {
    throw new OAuthException(400, 'unauthorized_client', `This client may not use the ${grantType} grant`)
  }
}

// ---------------------------------------------------------------------------- client secrets

/** How much of a secret is kept in the clear, purely so an operator can tell two rows apart. */
const SECRET_HINT_LENGTH = 6

/** Secrets that can authenticate right now: not revoked, and either eternal or not yet expired. */
const activeSecrets = async (db: Database, applicationId: string, now = new Date()) => {
  const rows = await db
    .select()
    .from(applicationSecrets)
    .where(eq(applicationSecrets.applicationId, applicationId))
    .orderBy(asc(applicationSecrets.createdAt))
  return rows.filter((row) => !row.revokedAt && (!row.expiresAt || row.expiresAt.getTime() > now.getTime()))
}

const listSecrets = async (db: Database, applicationId: string): Promise<ApplicationSecret[]> =>
  db
    .select()
    .from(applicationSecrets)
    .where(eq(applicationSecrets.applicationId, applicationId))
    .orderBy(asc(applicationSecrets.createdAt))

type IssueSecretInput = {
  applicationId: string
  label?: string | null
  /** Seconds until this secret expires on its own. Null (the default) means it never does. */
  expiresIn?: number | null
  createdBy?: string | null
}

/**
 * Mints a client secret. The plaintext is returned once, here, and nowhere else — only its SHA-256
 * hash is stored, exactly like every other token in this Worker.
 */
const issueSecret = async (db: Database, input: IssueSecretInput) => {
  const secret = randomToken(32)
  const now = new Date()
  const record: ApplicationSecret = {
    id: generateId(),
    applicationId: input.applicationId,
    secretHash: await sha256(secret),
    hint: secret.slice(0, SECRET_HINT_LENGTH),
    label: input.label ?? null,
    expiresAt: input.expiresIn ? new Date(now.getTime() + input.expiresIn * 1000) : null,
    lastUsedAt: null,
    revokedAt: null,
    createdBy: input.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(applicationSecrets).values(record)
  return { secret, record }
}

/**
 * Ends the life of every secret of a client except the one just issued.
 *
 * `graceSeconds` is what makes a rotation non-breaking: the outgoing secrets keep working for that
 * long, so every instance of the client has a window to pick the new value up. A grace of 0 cuts
 * them off immediately, which is what a leak calls for.
 */
const retireOtherSecrets = async (
  db: Database,
  applicationId: string,
  keepSecretId: string,
  graceSeconds: number,
): Promise<number> => {
  const outgoing = (await activeSecrets(db, applicationId)).filter((row) => row.id !== keepSecretId)
  if (outgoing.length === 0) {
    return 0
  }

  const now = new Date()
  const deadline = new Date(now.getTime() + graceSeconds * 1000)
  for (const row of outgoing) {
    // Never postpone an expiry that is already closer than the grace period would put it.
    const expiresAt = row.expiresAt && row.expiresAt.getTime() < deadline.getTime() ? row.expiresAt : deadline
    await db
      .update(applicationSecrets)
      .set(graceSeconds <= 0 ? { revokedAt: now, updatedAt: now } : { expiresAt, updatedAt: now })
      .where(eq(applicationSecrets.id, row.id))
  }
  return outgoing.length
}

const revokeSecret = async (db: Database, secretId: string) => {
  const now = new Date()
  await db
    .update(applicationSecrets)
    .set({ revokedAt: now, updatedAt: now })
    .where(eq(applicationSecrets.id, secretId))
}

/** Public shape of a secret. It never carries the secret itself, only enough to manage its life. */
const toPublicSecret = (secret: ApplicationSecret, now = new Date()) => ({
  id: secret.id,
  hint: secret.hint,
  label: secret.label,
  active: !secret.revokedAt && (!secret.expiresAt || secret.expiresAt.getTime() > now.getTime()),
  expires_at: secret.expiresAt?.toISOString() ?? null,
  last_used_at: secret.lastUsedAt?.toISOString() ?? null,
  revoked_at: secret.revokedAt?.toISOString() ?? null,
  created_at: secret.createdAt.toISOString(),
})

// ---------------------------------------------------------------------------- client authentication

type ClientCredentials = {
  clientId: string
  clientSecret: string | null
  /** Which envelope the credentials arrived in, checked against the client's registered method. */
  method: ClientAuthMethod
}

/**
 * Reads the client's credentials off a token-endpoint request.
 *
 * RFC 6749 §2.3.1 percent-encodes both halves before base64-ing them, which matters as soon as a
 * secret contains a character with a meaning in a form body. Sending credentials in both envelopes
 * at once is refused rather than resolved by precedence: it is always a client bug, and picking one
 * silently would hide it until the unused half was rotated.
 */
const readClientCredentials = (
  authorizationHeader: string | undefined,
  body: { client_id?: string; client_secret?: string },
): ClientCredentials => {
  const basic = parseBasicAuthorization(authorizationHeader)

  if (basic && body.client_secret) {
    throw new OAuthException(
      400,
      'invalid_request',
      'Client credentials were sent both in the Authorization header and in the body',
    )
  }

  if (basic) {
    if (body.client_id && body.client_id !== basic.clientId) {
      throw new OAuthException(400, 'invalid_request', 'client_id in the body does not match the Authorization header')
    }
    return { clientId: basic.clientId, clientSecret: basic.clientSecret, method: 'client_secret_basic' }
  }

  if (!body.client_id) {
    throw new OAuthException(400, 'invalid_request', 'client_id is required')
  }
  return {
    clientId: body.client_id,
    clientSecret: body.client_secret ?? null,
    method: body.client_secret ? 'client_secret_post' : 'none',
  }
}

const parseBasicAuthorization = (header: string | undefined) => {
  if (!header) {
    return null
  }
  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'basic' || rest.length === 0) {
    return null
  }

  let decoded: string
  try {
    decoded = new TextDecoder().decode(base64UrlDecode(rest.join(' ').trim()))
  } catch {
    throw new OAuthException(401, 'invalid_client', 'The Basic authorization header is not valid base64')
  }

  const separator = decoded.indexOf(':')
  if (separator === -1) {
    throw new OAuthException(401, 'invalid_client', 'The Basic authorization header must be "client_id:client_secret"')
  }

  const decodeComponent = (value: string) => {
    try {
      return decodeURIComponent(value)
    } catch {
      // A secret that is not percent-encoded at all is common enough in the wild to accept as-is.
      return value
    }
  }

  return {
    clientId: decodeComponent(decoded.slice(0, separator)),
    clientSecret: decodeComponent(decoded.slice(separator + 1)),
  }
}

/**
 * Authenticates the client at the token endpoint.
 *
 * A public client authenticates with PKCE alone and must send no secret. A confidential one is held
 * to the exact envelope it registered, and its secret is checked against every secret currently
 * alive for it — which is what makes a rotation overlap two working values instead of cutting the
 * old one off. The matching row is stamped with `last_used_at`, so an operator can see whether the
 * secret they are about to revoke is still being used by anything.
 */
const authenticateClient = async (
  db: Database,
  application: Application,
  credentials: Pick<ClientCredentials, 'clientSecret' | 'method'>,
): Promise<ApplicationSecret | null> => {
  const expected = getClientAuthMethod(application)

  if (expected === 'none') {
    if (credentials.clientSecret) {
      throw new OAuthException(401, 'invalid_client', 'This client is public and must not send a client_secret')
    }
    return null
  }

  if (!credentials.clientSecret) {
    throw new OAuthException(401, 'invalid_client', 'client_secret is required for this client')
  }
  if (credentials.method !== expected) {
    throw new OAuthException(
      401,
      'invalid_client',
      `This client must authenticate with ${expected}`,
    )
  }

  const presented = await sha256(credentials.clientSecret)
  const candidates = await activeSecrets(db, application.id)
  // Every candidate is compared, without an early exit, so the response time does not reveal how
  // many secrets are configured or which one matched.
  let matched: ApplicationSecret | null = null
  for (const candidate of candidates) {
    if (timingSafeEqual(presented, candidate.secretHash)) {
      matched ??= candidate
    }
  }

  if (!matched) {
    throw new OAuthException(401, 'invalid_client', 'Invalid client credentials')
  }

  const now = new Date()
  await db
    .update(applicationSecrets)
    .set({ lastUsedAt: now, updatedAt: now })
    .where(eq(applicationSecrets.id, matched.id))

  return matched
}

export {
  activeSecrets,
  assertGrantAllowed,
  authenticateClient,
  DEFAULT_SCOPE,
  getAllowedOrigins,
  getAllowedScopes,
  getApplication,
  getClientAuthMethod,
  getGrantTypes,
  getPostLogoutRedirectUris,
  getRedirectUris,
  hasScope,
  isConfidential,
  issueSecret,
  listSecrets,
  normalizeScope,
  parseStringList,
  readClientCredentials,
  resolveClient,
  retireOtherSecrets,
  revokeSecret,
  SECRET_HINT_LENGTH,
  SUPPORTED_SCOPES,
  toPublicSecret,
  validatePkceParameters,
}
export type { Application, ApplicationSecret, ClientCredentials, SupportedScope }
