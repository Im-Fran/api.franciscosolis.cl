import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * D1 schema for `franciscosolis_auth`.
 *
 * Conventions used across every table:
 * - Primary keys are UUID v4 strings, generated in the Worker (`crypto.randomUUID()`), so a row
 *   can be referenced before it is written and ids never leak insertion order.
 * - Timestamps are stored as unix seconds (`integer` + `{ mode: 'timestamp' }`) and default to
 *   `unixepoch()` so rows inserted by a migration or by hand also get sane values.
 * - Anything that travels to a user (magic link tokens, authorization codes, refresh tokens,
 *   invitation tokens) is stored ONLY as a SHA-256 hash. A database dump must not be enough to
 *   impersonate anyone.
 */

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}

/** End users. One row per human, regardless of how many providers they link. */
const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  /** Always stored lowercased and trimmed; it is the identity key shared across providers. */
  email: text('email').notNull(),
  emailVerifiedAt: integer('email_verified_at', { mode: 'timestamp' }),
  name: text('name'),
  givenName: text('given_name'),
  familyName: text('family_name'),
  picture: text('picture'),
  locale: text('locale'),
  /** `active` | `disabled`. A disabled user can neither sign in nor refresh a token. */
  status: text('status').notNull().default('active'),
  lastLoginAt: integer('last_login_at', { mode: 'timestamp' }),
  ...timestamps,
}, (table) => [
  uniqueIndex('users_email_unique').on(table.email),
])

/**
 * A provider-specific account bound to a user. `magic_link` identities use the email address as
 * `provider_account_id`; `google` identities use the OIDC `sub`, which is stable even if the
 * user later changes the email address on their Google account.
 */
const identities = sqliteTable('identities', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  providerAccountId: text('provider_account_id').notNull(),
  email: text('email'),
  /** Raw provider profile as JSON, kept for debugging and for backfilling new columns later. */
  profile: text('profile'),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  ...timestamps,
}, (table) => [
  uniqueIndex('identities_provider_account_unique').on(table.provider, table.providerAccountId),
  index('identities_user_id_idx').on(table.userId),
])

/**
 * Client applications allowed to start a login flow. `clientSecretHash` being null marks a public
 * client (a browser SPA): it cannot keep a secret, so PKCE is the only thing binding the
 * authorization code to the client that requested it.
 */
const applications = sqliteTable('applications', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  clientSecretHash: text('client_secret_hash'),
  /** JSON array of exact-match redirect URIs. No wildcards, no prefix matching. */
  redirectUris: text('redirect_uris').notNull().default('[]'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  ...timestamps,
})

/**
 * Roles are either global (`applicationId` null) or scoped to a single application, so the same
 * person can be an admin of one app and a plain user of another.
 */
const roles = sqliteTable('roles', {
  id: text('id').primaryKey(),
  applicationId: text('application_id').references(() => applications.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  /** Granted automatically the first time a user signs in to the matching scope. */
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  ...timestamps,
}, (table) => [
  // Two partial indexes instead of one composite: in SQLite `NULL != NULL`, so a plain
  // unique(application_id, slug) would happily accept two global roles with the same slug.
  uniqueIndex('roles_global_slug_unique').on(table.slug).where(sql`application_id is null`),
  uniqueIndex('roles_scoped_slug_unique').on(table.applicationId, table.slug).where(sql`application_id is not null`),
])

/** Fine-grained capabilities. Roles are bags of these; route guards check permissions, not roles. */
const permissions = sqliteTable('permissions', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  ...timestamps,
}, (table) => [
  uniqueIndex('permissions_slug_unique').on(table.slug),
])

const rolePermissions = sqliteTable('role_permissions', {
  roleId: text('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  permissionId: text('permission_id').notNull().references(() => permissions.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  primaryKey({ columns: [table.roleId, table.permissionId] }),
])

const userRoles = sqliteTable('user_roles', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  roleId: text('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  grantedBy: text('granted_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  primaryKey({ columns: [table.userId, table.roleId] }),
  index('user_roles_role_id_idx').on(table.roleId),
])

/**
 * Sign-up is invitation-only: a login attempt for an unknown email is rejected unless a pending
 * invitation exists for it. The row doubles as the allowlist entry and as the audit trail of who
 * invited whom.
 */
const invitations = sqliteTable('invitations', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  applicationId: text('application_id').references(() => applications.id, { onDelete: 'cascade' }),
  /** Role granted when the invitation is accepted. Falls back to the scope's default role. */
  roleId: text('role_id').references(() => roles.id, { onDelete: 'set null' }),
  invitedBy: text('invited_by').references(() => users.id, { onDelete: 'set null' }),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  acceptedAt: integer('accepted_at', { mode: 'timestamp' }),
  acceptedByUserId: text('accepted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  ...timestamps,
}, (table) => [
  index('invitations_email_idx').on(table.email),
])

/**
 * A pending magic link. The whole authorization request (redirect URI, PKCE challenge, client
 * state) is captured here so the emailed link only has to carry an opaque token: whatever the
 * mail client does to the URL, it cannot alter where the user is sent back to.
 */
const magicLinkTokens = sqliteTable('magic_link_tokens', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  applicationId: text('application_id').notNull().references(() => applications.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  state: text('state'),
  codeChallenge: text('code_challenge').notNull(),
  codeChallengeMethod: text('code_challenge_method').notNull().default('S256'),
  scope: text('scope'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  consumedAt: integer('consumed_at', { mode: 'timestamp' }),
  requestIp: text('request_ip'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex('magic_link_tokens_hash_unique').on(table.tokenHash),
  index('magic_link_tokens_email_created_idx').on(table.email, table.createdAt),
])

/**
 * In-flight redirect to an external provider. Holds both sides of the flow: the PKCE verifier and
 * nonce we send to the provider, and the client's own authorization request to resume afterwards.
 */
const oauthStates = sqliteTable('oauth_states', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  stateHash: text('state_hash').notNull(),
  applicationId: text('application_id').notNull().references(() => applications.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  /** The `state` the client application asked us to echo back; unrelated to `stateHash`. */
  clientState: text('client_state'),
  codeChallenge: text('code_challenge').notNull(),
  codeChallengeMethod: text('code_challenge_method').notNull().default('S256'),
  scope: text('scope'),
  /** PKCE verifier for our own request to the upstream provider. */
  providerCodeVerifier: text('provider_code_verifier').notNull(),
  nonce: text('nonce').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  consumedAt: integer('consumed_at', { mode: 'timestamp' }),
  requestIp: text('request_ip'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex('oauth_states_hash_unique').on(table.stateHash),
])

/** Short-lived, single-use code handed to the client app in the redirect, exchanged at /oauth/token. */
const authorizationCodes = sqliteTable('authorization_codes', {
  id: text('id').primaryKey(),
  codeHash: text('code_hash').notNull(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  applicationId: text('application_id').notNull().references(() => applications.id, { onDelete: 'cascade' }),
  /** Provider that actually authenticated the user, propagated onto the session. */
  provider: text('provider').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  codeChallengeMethod: text('code_challenge_method').notNull().default('S256'),
  scope: text('scope'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  consumedAt: integer('consumed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex('authorization_codes_hash_unique').on(table.codeHash),
])

/**
 * One row per sign-in on one device/app. Revoking it kills the whole refresh-token chain at once,
 * which is what "sign out this device" means.
 */
const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  applicationId: text('application_id').notNull().references(() => applications.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  /** Scope granted at sign-in. Refreshing re-issues the same scope; it can never be widened. */
  scope: text('scope'),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  revokedReason: text('revoked_reason'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  index('sessions_user_id_idx').on(table.userId),
])

/**
 * Rotating refresh tokens. Each exchange marks the current token used and issues a child; seeing a
 * token that was already used means it leaked, and the entire session is revoked.
 * `parentId` is deliberately not a foreign key so pruning old rows cannot cascade a chain away.
 */
const refreshTokens = sqliteTable('refresh_tokens', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  applicationId: text('application_id').notNull().references(() => applications.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  parentId: text('parent_id'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  usedAt: integer('used_at', { mode: 'timestamp' }),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  revokedReason: text('revoked_reason'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex('refresh_tokens_hash_unique').on(table.tokenHash),
  index('refresh_tokens_session_id_idx').on(table.sessionId),
])

/** Append-only trail of security-relevant events. Never updated, never deleted by the Worker. */
const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  event: text('event').notNull(),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  applicationId: text('application_id').references(() => applications.id, { onDelete: 'set null' }),
  ip: text('ip'),
  userAgent: text('user_agent'),
  /** Free-form JSON payload; must never contain a token, a secret or a raw provider profile. */
  metadata: text('metadata'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  index('audit_logs_user_id_idx').on(table.userId),
  index('audit_logs_created_at_idx').on(table.createdAt),
])

export {
  applications,
  auditLogs,
  authorizationCodes,
  identities,
  invitations,
  magicLinkTokens,
  oauthStates,
  permissions,
  refreshTokens,
  rolePermissions,
  roles,
  sessions,
  userRoles,
  users,
}
