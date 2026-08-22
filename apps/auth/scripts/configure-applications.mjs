#!/usr/bin/env node
/**
 * Registers and configures the OAuth client applications of the auth Worker from the command line.
 *
 * Usage: `pnpm run applications -- <command> [options]` (add `--remote` for the real database).
 *
 * The admin API (`/auth/admin/applications`) already does this over HTTP, but it needs an access
 * token carrying `applications:write`, which nobody has before the first client application exists
 * to sign in through. So, like `bootstrap-admin.mjs`, this talks to D1 directly through Wrangler.
 * It is an operator tool: it is the way to register the first client, to rotate a leaked secret
 * without a browser, and to script an environment from scratch.
 *
 * Everything it writes mirrors what the admin routes write — same validation rules, same
 * base64url-encoded 32-byte secret hashed with SHA-256, same audit events — so a client created
 * here is indistinguishable from one created through the API.
 */
import { spawnSync } from 'node:child_process'
import { randomUUID, webcrypto } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'

const DATABASE = 'franciscosolis_auth'

/** Same rule as `createApplicationSchema` in src/routes/admin/applications.ts. */
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/

const USAGE = `
Configure the client applications of the auth Worker.

Usage: pnpm run applications -- <command> [options]

Commands:
  list                        List every registered client application
  show <client-id>            Show one client application in full, with its secrets
  create [<client-id>]        Register a client application (prompts for anything not given)
  update <client-id>          Change name, description, redirect URIs, policy or status
  rotate-secret <client-id>   Issue a new client secret, printed once and never again
  revoke-secret <client-id>   Revoke one secret of a client, by its id
  delete <client-id>          Remove a client application and everything that hangs off it

Options:
  --remote                    Act on the real franciscosolis_auth database (default: local)
  --client-id <id>            Client id, lowercase alphanumeric and dashes
  --name <name>               Display name
  --description <text>        Description ("" clears it)
  --redirect-uri <url>        Redirect URI; repeat to pass several. Replaces the whole list
  --add-redirect-uri <url>    Add one redirect URI, keeping the existing ones (update only)
  --remove-redirect-uri <url> Drop one redirect URI (update only)
  --post-logout-uri <url>     Post-logout redirect URI; repeat to pass several
  --allowed-origin <origin>   Extra browser origin allowed to call the OAuth endpoints; repeat.
                              A leading *. means any subdomain, e.g. https://*.example.workers.dev
  --grant-type <name>         Grant the client may use; repeat. Replaces the whole list
  --scope <name>              Scope the client may request; repeat. Empty means every supported one
  --auth-method <method>      none | client_secret_post | client_secret_basic
  --confidential              Shorthand for --auth-method client_secret_post
  --public                    Shorthand for --auth-method none; on update, revokes every secret
  --no-pkce                   Stop requiring PKCE (confidential clients only)
  --require-pkce              Require PKCE again
  --grace <seconds>           Rotation: how long the outgoing secrets keep working (default 604800)
  --secret-id <id>            Which secret to revoke (revoke-secret only)
  --label <text>              Label for the secret being issued
  --activate / --deactivate   Enable or disable sign-ins for the client (update only)
  --json                      Print machine-readable JSON instead of a table
  --dry-run                   Print the SQL that would run, without running it
  -y, --yes                   Skip confirmation prompts
  -h, --help                  Show this help

Examples:
  pnpm run applications -- list --remote
  pnpm run applications -- create franciscosolis-web --name "Landing" --redirect-uri https://franciscosolis.cl/auth/callback
  pnpm run applications -- update franciscosolis-cms --add-redirect-uri http://localhost:5174/auth/callback
  pnpm run applications -- rotate-secret my-backend --grace 86400 --remote
  pnpm run applications -- rotate-secret my-backend --grace 0 --remote     # a leak: cut the old one off now
  pnpm run applications -- create cloudflare-access --auth-method client_secret_post --no-pkce \\
    --redirect-uri https://team.cloudflareaccess.com/cdn-cgi/access/callback
`

const OPTIONS = {
  remote: { type: 'boolean' },
  json: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  help: { type: 'boolean', short: 'h' },
  'client-id': { type: 'string' },
  name: { type: 'string' },
  description: { type: 'string' },
  'redirect-uri': { type: 'string', multiple: true },
  'add-redirect-uri': { type: 'string', multiple: true },
  'remove-redirect-uri': { type: 'string', multiple: true },
  'post-logout-uri': { type: 'string', multiple: true },
  'allowed-origin': { type: 'string', multiple: true },
  'grant-type': { type: 'string', multiple: true },
  scope: { type: 'string', multiple: true },
  'auth-method': { type: 'string' },
  confidential: { type: 'boolean' },
  public: { type: 'boolean' },
  'no-pkce': { type: 'boolean' },
  'require-pkce': { type: 'boolean' },
  grace: { type: 'string' },
  'secret-id': { type: 'string' },
  label: { type: 'string' },
  activate: { type: 'boolean' },
  deactivate: { type: 'boolean' },
}

class UsageError extends Error {}

const fail = (message) => {
  throw new UsageError(message)
}

// ---------------------------------------------------------------------------- argument parsing

let values
let positionals
try {
  ;({ values, positionals } = parseArgs({ allowPositionals: true, options: OPTIONS }))
} catch (error) {
  console.error(`${error.message}\n${USAGE}`)
  process.exit(1)
}

const command = positionals[0] ?? (values.help ? 'help' : 'list')
const remote = values.remote === true
const asJson = values.json === true
const dryRun = values['dry-run'] === true
const assumeYes = values.yes === true
/** Prompting is only possible on a terminal, and JSON output must stay parseable. */
const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true && !asJson

// ---------------------------------------------------------------------------- crypto helpers

const base64Url = (bytes) => Buffer.from(bytes).toString('base64url')

/** Mirrors `randomToken(32)` in src/lib/crypto.ts: 32 random bytes, base64url, no padding. */
const randomToken = (size = 32) => base64Url(webcrypto.getRandomValues(new Uint8Array(size)))

/** Mirrors `sha256` in src/lib/crypto.ts, so a secret minted here verifies in the Worker. */
const sha256 = async (value) => base64Url(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))

// ---------------------------------------------------------------------------- SQL helpers

/** True for anything a name, description or URI has no business carrying into a SQL literal. */
const hasControlCharacter = (text) =>
  [...text].some((character) => {
    const code = character.codePointAt(0)
    // Tab (9) and line feed (10) are the only ones a description may legitimately contain.
    return code === 127 || (code < 32 && code !== 9 && code !== 10)
  })

/**
 * Quotes a value as a SQL string literal. Wrangler takes a whole statement, so values are
 * interpolated rather than bound: doubling the quote is the escape SQLite defines, and control
 * characters — which no legitimate name, description or URI contains — are refused outright
 * instead of being encoded, because this may be writing to the production database.
 */
const quote = (value) => {
  if (value === null || value === undefined) {
    return 'NULL'
  }
  const text = String(value)
  if (hasControlCharacter(text)) {
    fail(`Refusing to write a value containing control characters: ${JSON.stringify(text)}`)
  }
  return `'${text.replace(/'/g, "''")}'`
}

const auditStatement = (event, { applicationId = null, metadata = {} } = {}) =>
  `INSERT INTO audit_logs (id, event, application_id, metadata) VALUES (${quote(randomUUID())}, ${quote(event)}, ${quote(applicationId)}, ${quote(JSON.stringify({ source: 'cli', ...metadata }))});`

/**
 * Runs SQL through `wrangler d1 execute` and returns the rows of every statement, flattened.
 * `--json` keeps Wrangler's banner out of the output; failures print Wrangler's own stderr, which
 * is more useful than anything this script could reword.
 */
const query = (sql) => {
  const result = spawnSync(
    'wrangler',
    ['d1', 'execute', DATABASE, remote ? '--remote' : '--local', '--json', '--yes', '--command', sql],
    { encoding: 'utf8' },
  )

  if (result.error?.code === 'ENOENT') {
    fail('wrangler was not found — run this from apps/auth through pnpm, after `pnpm install`.')
  }
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '')
    process.exit(result.status ?? 1)
  }

  // With --json the payload is `[{ results, success, meta }, …]`, one entry per statement, but be
  // tolerant of anything Wrangler prints before it.
  const start = result.stdout.indexOf('[')
  if (start === -1) {
    fail(`Could not read Wrangler's output:\n${result.stdout}`)
  }
  try {
    return JSON.parse(result.stdout.slice(start)).flatMap((entry) => entry.results ?? [])
  } catch {
    return fail(`Could not parse Wrangler's output:\n${result.stdout}`)
  }
}

/**
 * Runs the statements that change something. `--dry-run` withholds these and prints them instead —
 * reads keep running, so a dry run still validates against the real state of the database.
 */
const execute = (sql) => {
  if (dryRun) {
    console.log(sql.trim())
    return
  }
  query(sql)
}

// ---------------------------------------------------------------------------- domain helpers

const parseRedirectUris = (raw) => {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((uri) => typeof uri === 'string') : []
  } catch {
    return []
  }
}

/** Client authentication methods, mirroring `CLIENT_AUTH_METHODS` in src/lib/config.ts. */
const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic']
/** Grants, mirroring `GRANT_TYPES`. */
const GRANT_TYPES = ['authorization_code', 'refresh_token', 'client_credentials']
/** Scopes, mirroring `SUPPORTED_SCOPES` in src/services/applications.ts. */
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'roles', 'groups']
/** Default rotation grace, mirroring `TTL.clientSecretGrace`. */
const DEFAULT_GRACE_SECONDS = 7 * 24 * 60 * 60

/** The shape the admin API returns, so `--json` output is interchangeable with it. */
const toPublicApplication = (row) => ({
  client_id: row.id,
  name: row.name,
  description: row.description,
  confidential: row.token_endpoint_auth_method !== 'none',
  token_endpoint_auth_method: row.token_endpoint_auth_method,
  redirect_uris: parseRedirectUris(row.redirect_uris),
  post_logout_redirect_uris: parseRedirectUris(row.post_logout_redirect_uris),
  grant_types: parseRedirectUris(row.grant_types),
  scopes: parseRedirectUris(row.scopes),
  require_pkce: Boolean(row.require_pkce),
  allowed_origins: parseRedirectUris(row.allowed_origins),
  is_active: Boolean(row.is_active),
  created_at: new Date(row.created_at * 1000).toISOString(),
  updated_at: new Date(row.updated_at * 1000).toISOString(),
})

/** Metadata of one secret. Never its value — only the hash is stored, and not even that is shown. */
const toPublicSecret = (row) => ({
  id: row.id,
  hint: row.hint,
  label: row.label,
  active: !row.revoked_at && (!row.expires_at || row.expires_at * 1000 > Date.now()),
  expires_at: row.expires_at ? new Date(row.expires_at * 1000).toISOString() : null,
  last_used_at: row.last_used_at ? new Date(row.last_used_at * 1000).toISOString() : null,
  revoked_at: row.revoked_at ? new Date(row.revoked_at * 1000).toISOString() : null,
  created_at: new Date(row.created_at * 1000).toISOString(),
})

const listSecrets = (clientId) =>
  query(`SELECT * FROM application_secrets WHERE application_id = ${quote(clientId)} ORDER BY created_at;`).map(
    toPublicSecret,
  )

const listApplications = () =>
  query('SELECT * FROM applications ORDER BY created_at DESC;').map(toPublicApplication)

const findApplication = (clientId) => {
  const [row] = query(`SELECT * FROM applications WHERE id = ${quote(clientId)} LIMIT 1;`)
  return row ? toPublicApplication(row) : null
}

const requireApplication = (clientId) => {
  const application = findApplication(clientId)
  if (!application) {
    fail(`No client application with id ${JSON.stringify(clientId)} in the ${remote ? 'remote' : 'local'} database.`)
  }
  return application
}

const validateClientId = (clientId) => {
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    fail('client_id must be 2-63 characters, lowercase letters, digits or dashes, and start with a letter or digit.')
  }
  return clientId
}

const validateName = (name) => {
  const trimmed = name.trim()
  if (trimmed.length < 1 || trimmed.length > 120) {
    fail('name must be between 1 and 120 characters.')
  }
  return trimmed
}

/**
 * Redirect URIs are compared by exact string match at authorization time, so anything that would
 * not survive that comparison is rejected here rather than stored and silently never matched.
 */
const validateRedirectUri = (uri) => {
  const trimmed = uri.trim()
  if (trimmed.includes('#')) {
    fail(`A redirect URI must not contain a fragment: ${trimmed}`)
  }
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return fail(`Not an absolute URL: ${trimmed}`)
  }
  if (parsed.href !== trimmed) {
    fail(`Redirect URI is not in its canonical form — register ${parsed.href} instead of ${trimmed}`)
  }
  // The `*.` an allowed origin may carry has no meaning here, and storing one would read as a
  // wildcard on where an authorization code may be sent.
  if (parsed.hostname.includes('*')) {
    fail(`A redirect URI is matched exactly and cannot carry a wildcard: ${trimmed}`)
  }
  return trimmed
}

const validateRedirectUris = (uris) => {
  const validated = uris.map(validateRedirectUri)
  const unique = [...new Set(validated)]
  if (unique.length === 0) {
    fail('At least one redirect URI is required.')
  }
  return unique
}

/**
 * An origin is scheme://host[:port] and nothing else — what a browser puts in the Origin header.
 *
 * A leading `*.` label is also accepted and means any subdomain of the host below it, which is how
 * a Cloudflare preview deployment gets to call the Worker at all: its hostname only exists once the
 * deployment does. The rule mirrors `src/lib/origins.ts` — the wildcard replaces only the leftmost
 * labels, must leave at least two below it, and never applies to a redirect URI. Change both.
 */
const WILDCARD_ORIGIN_PREFIX = '*.'
const MIN_WILDCARD_ANCHOR_LABELS = 2

const validateOrigin = (value) => {
  const origin = value.trim()
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return fail(`Not an absolute URL: ${value}`)
  }
  if (parsed.origin !== origin) {
    fail(`An allowed origin must be exactly scheme://host[:port] — pass ${parsed.origin} instead of ${value}`)
  }
  if (parsed.hostname.startsWith(WILDCARD_ORIGIN_PREFIX)) {
    const anchor = parsed.hostname.slice(WILDCARD_ORIGIN_PREFIX.length)
    if (anchor.split('.').filter(Boolean).length < MIN_WILDCARD_ANCHOR_LABELS) {
      fail(`A wildcard origin must leave at least two labels below the *: ${value}`)
    }
  } else if (parsed.hostname.includes('*')) {
    fail(`A * is only allowed as the leftmost label of an origin: ${value}`)
  }
  return parsed.origin
}

const validateFromSet = (values, allowed, label) => {
  const unknown = values.filter((value) => !allowed.includes(value))
  if (unknown.length > 0) {
    fail(`Unknown ${label}: ${unknown.join(', ')}. Pick from: ${allowed.join(', ')}`)
  }
  return [...new Set(values)]
}

/**
 * Resolves the client authentication method from the three ways of spelling it, and refuses the
 * combination that would leave a client with nothing binding an authorization code to it.
 */
const resolveAuthMethod = (current) => {
  const flags = [values['auth-method'] !== undefined, values.confidential === true, values.public === true].filter(
    Boolean,
  ).length
  if (flags > 1) {
    fail('--auth-method, --confidential and --public all say the same thing; pass only one.')
  }
  if (values['auth-method'] !== undefined) {
    return validateFromSet([values['auth-method']], AUTH_METHODS, 'authentication method')[0]
  }
  if (values.confidential === true) {
    return 'client_secret_post'
  }
  if (values.public === true) {
    return 'none'
  }
  return current
}

/**
 * Mirrors `resolvePkceRule` in src/routes/admin/applications.ts: a public client always requires
 * PKCE. Asking for both at once fails; making a client public while PKCE happened to be off
 * re-arms PKCE instead, which is the direction that is safe.
 */
const resolveRequirePkce = (current, authMethod) => {
  if (values['no-pkce'] === true && values['require-pkce'] === true) {
    fail('--no-pkce and --require-pkce are mutually exclusive.')
  }
  const requirePkce = values['no-pkce'] === true ? false : values['require-pkce'] === true ? true : current
  if (requirePkce || authMethod !== 'none') {
    return requirePkce
  }
  if (values['no-pkce'] === true) {
    fail(
      'PKCE can only be turned off for a confidential client: a public one has nothing else binding the ' +
        'authorization code to whoever asked for it.',
    )
  }
  return true
}

const graceSeconds = () => {
  if (values.grace === undefined) {
    return DEFAULT_GRACE_SECONDS
  }
  const seconds = Number(values.grace)
  if (!Number.isInteger(seconds) || seconds < 0) {
    fail('--grace takes a whole number of seconds, 0 or more.')
  }
  return seconds
}

/** Mirrors the UUID v4 the Worker generates, so a row written here is shaped like any other. */
const secretRow = async (clientId, secret, label) => ({
  id: randomUUID(),
  applicationId: clientId,
  hash: await sha256(secret),
  hint: secret.slice(0, 6),
  label: label ?? null,
})

// ---------------------------------------------------------------------------- terminal helpers

let rl = null
const readline = () => (rl ??= createInterface({ input: process.stdin, output: process.stdout }))
const closeReadline = () => rl?.close()

const ask = async (question, fallback = '') => {
  const answer = (await readline().question(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim()
  return answer || fallback
}

const askYesNo = async (question, fallback) => {
  const answer = (await readline().question(`${question} [${fallback ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase()
  return answer ? ['y', 'yes'].includes(answer) : fallback
}

const confirm = async (question) => {
  if (assumeYes || dryRun) {
    return true
  }
  if (!interactive) {
    fail(`${question} Re-run with --yes to confirm non-interactively.`)
  }
  return askYesNo(question, false)
}

const printApplication = (application) => {
  console.log(`  client_id     ${application.client_id}`)
  console.log(`  name          ${application.name}`)
  console.log(`  description   ${application.description ?? '—'}`)
  console.log(`  type          ${application.confidential ? 'confidential (client secret)' : 'public (PKCE only)'}`)
  console.log(`  auth method   ${application.token_endpoint_auth_method}`)
  console.log(`  PKCE          ${application.require_pkce ? 'required' : 'not required'}`)
  console.log(`  grants        ${application.grant_types.join(', ') || '—'}`)
  console.log(`  scopes        ${application.scopes.join(', ') || 'every supported scope'}`)
  console.log(`  status        ${application.is_active ? 'active' : 'inactive'}`)
  console.log(`  created       ${application.created_at}`)
  console.log(`  updated       ${application.updated_at}`)
  console.log('  redirect URIs')
  for (const uri of application.redirect_uris) {
    console.log(`    - ${uri}`)
  }
  if (application.post_logout_redirect_uris.length > 0) {
    console.log('  post-logout URIs')
    for (const uri of application.post_logout_redirect_uris) {
      console.log(`    - ${uri}`)
    }
  }
  if (application.allowed_origins.length > 0) {
    console.log('  extra CORS origins')
    for (const origin of application.allowed_origins) {
      console.log(`    - ${origin}`)
    }
  }
}

const printSecrets = (secrets) => {
  if (secrets.length === 0) {
    console.log('  secrets       none')
    return
  }
  console.log('  secrets')
  for (const secret of secrets) {
    const state = secret.revoked_at ? 'revoked' : secret.active ? 'active' : 'expired'
    const until = secret.expires_at ? `, until ${secret.expires_at}` : ''
    const used = secret.last_used_at ? `, last used ${secret.last_used_at}` : ', never used'
    console.log(`    - ${secret.id}  ${secret.hint}…  ${state}${until}${used}${secret.label ? `  (${secret.label})` : ''}`)
  }
}

const printTable = (applications) => {
  const rows = applications.map((application) => [
    application.client_id,
    application.name,
    application.confidential ? 'confidential' : 'public',
    application.is_active ? 'active' : 'inactive',
    String(application.redirect_uris.length),
  ])
  const header = ['CLIENT ID', 'NAME', 'TYPE', 'STATUS', 'URIS']
  const widths = header.map((label, column) => Math.max(label.length, ...rows.map((row) => row[column].length)))
  const line = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd()

  console.log(line(header))
  for (const row of rows) {
    console.log(line(row))
  }
}

// ---------------------------------------------------------------------------- commands

const runList = () => {
  const applications = listApplications()
  if (asJson) {
    console.log(JSON.stringify(applications, null, 2))
    return
  }
  if (applications.length === 0) {
    console.log(`No client applications registered in the ${remote ? 'remote' : 'local'} database.`)
    return
  }
  printTable(applications)
}

const runShow = (clientId) => {
  const application = requireApplication(clientId)
  const secrets = listSecrets(clientId)
  if (asJson) {
    console.log(JSON.stringify({ ...application, secrets }, null, 2))
    return
  }
  printApplication(application)
  printSecrets(secrets)
}

const runCreate = async (positionalClientId) => {
  let clientId = positionalClientId ?? values['client-id']
  let name = values.name
  let description = values.description
  let redirectUris = values['redirect-uri'] ?? []
  // Absent flags mean "public", matching the admin API's default, but on a terminal it is worth
  // asking rather than quietly picking the weaker of the two.
  let authMethod = resolveAuthMethod('none')

  if (interactive) {
    clientId ??= await ask('client_id')
    name ??= await ask('Name', clientId)
    description ??= await ask('Description (optional)')
    while (redirectUris.length === 0) {
      const answer = await ask('Redirect URIs (comma separated)')
      redirectUris = answer.split(',').map((uri) => uri.trim()).filter(Boolean)
    }
    if (values['auth-method'] === undefined && values.confidential !== true && values.public !== true) {
      authMethod = (await askYesNo('Confidential client (issues a client secret)?', false))
        ? 'client_secret_post'
        : 'none'
    }
  }

  if (!clientId) {
    fail('A client id is required: pass it as the first argument or as --client-id.')
  }
  if (redirectUris.length === 0) {
    fail('At least one --redirect-uri is required.')
  }

  validateClientId(clientId)
  const application = {
    client_id: clientId,
    name: validateName(name ?? clientId),
    description: description ? description : null,
    token_endpoint_auth_method: authMethod,
    redirect_uris: validateRedirectUris(redirectUris),
    post_logout_redirect_uris: (values['post-logout-uri'] ?? []).map(validateRedirectUri),
    grant_types: validateFromSet(
      values['grant-type'] ?? ['authorization_code', 'refresh_token'],
      GRANT_TYPES,
      'grant type',
    ),
    scopes: validateFromSet(values.scope ?? [], SCOPES, 'scope'),
    require_pkce: resolveRequirePkce(true, authMethod),
    allowed_origins: (values['allowed-origin'] ?? []).map(validateOrigin),
    is_active: true,
  }

  if (findApplication(clientId)) {
    fail(`${clientId} is already registered. Use \`update\` to change it.`)
  }

  // A confidential client is useless without one, so the first secret is written with the client
  // rather than left to a second command the operator could forget.
  const clientSecret = authMethod === 'none' ? null : randomToken(32)
  const secret = clientSecret ? await secretRow(clientId, clientSecret, 'Initial secret') : null

  const sql = `
INSERT INTO applications (
  id, name, description, token_endpoint_auth_method, redirect_uris, post_logout_redirect_uris,
  grant_types, scopes, require_pkce, allowed_origins, is_active
) VALUES (
  ${quote(application.client_id)},
  ${quote(application.name)},
  ${quote(application.description)},
  ${quote(application.token_endpoint_auth_method)},
  ${quote(JSON.stringify(application.redirect_uris))},
  ${quote(JSON.stringify(application.post_logout_redirect_uris))},
  ${quote(JSON.stringify(application.grant_types))},
  ${quote(JSON.stringify(application.scopes))},
  ${application.require_pkce ? 1 : 0},
  ${quote(JSON.stringify(application.allowed_origins))},
  1
);
${secret ? secretInsert(secret) : ''}
${auditStatement('application.created', {
    applicationId: application.client_id,
    metadata: { token_endpoint_auth_method: authMethod, grant_types: application.grant_types },
  })}
`
  execute(sql)
  if (dryRun) {
    return
  }

  // Read the row back rather than echoing the input, so the timestamps are the stored ones.
  const created = findApplication(application.client_id)
  if (asJson) {
    console.log(JSON.stringify({ ...created, client_secret: clientSecret }, null, 2))
    return
  }

  console.log(`\nRegistered ${application.client_id} in the ${remote ? 'remote' : 'local'} database.\n`)
  printApplication(created)
  if (clientSecret) {
    console.log(`\n  client_secret ${clientSecret}`)
    console.log('\nOnly its SHA-256 hash is stored — copy it now, it cannot be read back.')
  }
}

const secretInsert = (secret, expiresAt = null) => `
INSERT INTO application_secrets (id, application_id, secret_hash, hint, label, expires_at) VALUES (
  ${quote(secret.id)},
  ${quote(secret.applicationId)},
  ${quote(secret.hash)},
  ${quote(secret.hint)},
  ${quote(secret.label)},
  ${expiresAt === null ? 'NULL' : String(expiresAt)}
);`

const runUpdate = async (clientId) => {
  const application = requireApplication(clientId)
  const changes = {}

  const replaced = values['redirect-uri'] ?? []
  const added = values['add-redirect-uri'] ?? []
  const removed = values['remove-redirect-uri'] ?? []

  if (replaced.length > 0 && (added.length > 0 || removed.length > 0)) {
    fail('--redirect-uri replaces the whole list, so it cannot be combined with --add/--remove-redirect-uri.')
  }
  if (values.activate === true && values.deactivate === true) {
    fail('--activate and --deactivate are mutually exclusive.')
  }

  if (values.name !== undefined) {
    changes.name = validateName(values.name)
  }
  if (values.description !== undefined) {
    changes.description = values.description === '' ? null : values.description
  }
  if (replaced.length > 0) {
    changes.redirect_uris = validateRedirectUris(replaced)
  } else if (added.length > 0 || removed.length > 0) {
    const dropped = removed.map(validateRedirectUri)
    const unknown = dropped.filter((uri) => !application.redirect_uris.includes(uri))
    if (unknown.length > 0) {
      fail(`Not a registered redirect URI of ${clientId}: ${unknown.join(', ')}`)
    }
    changes.redirect_uris = validateRedirectUris([
      ...application.redirect_uris.filter((uri) => !dropped.includes(uri)),
      ...added,
    ])
  }
  if (values.activate === true || values.deactivate === true) {
    changes.is_active = values.activate === true
  }
  if ((values['post-logout-uri'] ?? []).length > 0) {
    changes.post_logout_redirect_uris = (values['post-logout-uri'] ?? []).map(validateRedirectUri)
  }
  if ((values['allowed-origin'] ?? []).length > 0) {
    changes.allowed_origins = (values['allowed-origin'] ?? []).map(validateOrigin)
  }
  if ((values['grant-type'] ?? []).length > 0) {
    changes.grant_types = validateFromSet(values['grant-type'], GRANT_TYPES, 'grant type')
  }
  if ((values.scope ?? []).length > 0) {
    changes.scopes = validateFromSet(values.scope, SCOPES, 'scope')
  }

  const authMethod = resolveAuthMethod(application.token_endpoint_auth_method)
  if (authMethod !== application.token_endpoint_auth_method) {
    changes.token_endpoint_auth_method = authMethod
  }
  const requirePkce = resolveRequirePkce(application.require_pkce, authMethod)
  if (requirePkce !== application.require_pkce) {
    changes.require_pkce = requirePkce
  }

  // No flags on a terminal means the operator wants to edit the client, not read the usage.
  if (Object.keys(changes).length === 0) {
    if (!interactive) {
      fail('Nothing to update — pass at least one of --name, --description, --redirect-uri, --activate or --deactivate.')
    }
    console.log(`Editing ${clientId}; press enter to keep the current value.\n`)
    changes.name = validateName(await ask('Name', application.name))
    const description = await ask('Description (- to clear)', application.description ?? '')
    changes.description = description === '-' || description === '' ? null : description
    changes.redirect_uris = validateRedirectUris(
      (await ask('Redirect URIs (comma separated)', application.redirect_uris.join(',')))
        .split(',')
        .map((uri) => uri.trim())
        .filter(Boolean),
    )
    changes.is_active = await askYesNo('Active?', application.is_active)
  }

  const assignments = [
    ...(changes.name === undefined ? [] : [`name = ${quote(changes.name)}`]),
    ...(changes.description === undefined ? [] : [`description = ${quote(changes.description)}`]),
    ...(changes.redirect_uris === undefined ? [] : [`redirect_uris = ${quote(JSON.stringify(changes.redirect_uris))}`]),
    ...(changes.post_logout_redirect_uris === undefined
      ? []
      : [`post_logout_redirect_uris = ${quote(JSON.stringify(changes.post_logout_redirect_uris))}`]),
    ...(changes.allowed_origins === undefined
      ? []
      : [`allowed_origins = ${quote(JSON.stringify(changes.allowed_origins))}`]),
    ...(changes.grant_types === undefined ? [] : [`grant_types = ${quote(JSON.stringify(changes.grant_types))}`]),
    ...(changes.scopes === undefined ? [] : [`scopes = ${quote(JSON.stringify(changes.scopes))}`]),
    ...(changes.token_endpoint_auth_method === undefined
      ? []
      : [`token_endpoint_auth_method = ${quote(changes.token_endpoint_auth_method)}`]),
    ...(changes.require_pkce === undefined ? [] : [`require_pkce = ${changes.require_pkce ? 1 : 0}`]),
    ...(changes.is_active === undefined ? [] : [`is_active = ${changes.is_active ? 1 : 0}`]),
    'updated_at = unixepoch()',
  ]

  // A public client authenticates with PKCE alone, so a secret left behind it is a value that
  // exists in the database and can no longer be presented anywhere. Mirrors the admin route.
  const revokeAll =
    changes.token_endpoint_auth_method === 'none'
      ? `\nUPDATE application_secrets SET revoked_at = unixepoch(), updated_at = unixepoch() WHERE application_id = ${quote(clientId)} AND revoked_at IS NULL;`
      : ''

  const sql = `
UPDATE applications SET ${assignments.join(', ')} WHERE id = ${quote(clientId)};${revokeAll}
${auditStatement('application.updated', { applicationId: clientId, metadata: { fields: Object.keys(changes) } })}
`
  execute(sql)
  if (dryRun) {
    return
  }

  const updated = findApplication(clientId)
  if (asJson) {
    console.log(JSON.stringify(updated, null, 2))
    return
  }
  console.log(`\nUpdated ${clientId}.\n`)
  printApplication(updated)
  if (changes.is_active === false) {
    console.log('\nNew sign-ins are refused immediately; access tokens already issued stay valid until they expire.')
  }
  if (changes.token_endpoint_auth_method === 'none') {
    console.log('\nEvery client secret was revoked — the client now authenticates with PKCE alone.')
  }
}

/**
 * Issues a new secret and gives the outgoing ones a deadline instead of cutting them off.
 *
 * The grace period is the whole point: every instance of the client keeps authenticating with the
 * old value until it has picked the new one up. `--grace 0` ends them at once, which is the right
 * answer for a leak and the wrong one for a routine rotation.
 */
const runRotateSecret = async (clientId) => {
  const application = requireApplication(clientId)
  const authMethod = resolveAuthMethod(application.token_endpoint_auth_method)

  if (authMethod === 'none') {
    fail(
      `${clientId} is a public client and has no secret. Pass --confidential (or --auth-method) to turn it into a ` +
        'confidential client, but only if it can actually keep a secret — a browser app cannot.',
    )
  }

  const grace = graceSeconds()
  const outgoing = listSecrets(clientId).filter((secret) => secret.active)
  const question =
    outgoing.length === 0
      ? `Issue a first client secret for ${clientId}?`
      : grace === 0
        ? `Rotate the client secret of ${clientId}? The ${outgoing.length} secret(s) in use stop working immediately.`
        : `Rotate the client secret of ${clientId}? The ${outgoing.length} secret(s) in use keep working for ${grace} seconds.`

  if (!(await confirm(question))) {
    console.log('Aborted.')
    return
  }

  const clientSecret = randomToken(32)
  const secret = await secretRow(clientId, clientSecret, values.label ?? 'Rotated')

  const retire =
    outgoing.length === 0
      ? ''
      : grace === 0
        ? `\nUPDATE application_secrets SET revoked_at = unixepoch(), updated_at = unixepoch() WHERE application_id = ${quote(clientId)} AND id != ${quote(secret.id)} AND revoked_at IS NULL;`
        : // `MIN` so a rotation never postpones an expiry that was already closer than the grace period.
          `\nUPDATE application_secrets SET expires_at = MIN(COALESCE(expires_at, unixepoch() + ${grace}), unixepoch() + ${grace}), updated_at = unixepoch() WHERE application_id = ${quote(clientId)} AND id != ${quote(secret.id)} AND revoked_at IS NULL;`

  const promote =
    authMethod === application.token_endpoint_auth_method
      ? ''
      : `\nUPDATE applications SET token_endpoint_auth_method = ${quote(authMethod)}, updated_at = unixepoch() WHERE id = ${quote(clientId)};`

  const sql = `
${secretInsert(secret)}${retire}${promote}
${auditStatement('application.secret_rotated', {
    applicationId: clientId,
    metadata: { secret_id: secret.id, retired: outgoing.length, grace_seconds: grace },
  })}
`
  execute(sql)
  if (dryRun) {
    return
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        { client_id: clientId, client_secret: clientSecret, secret_id: secret.id, retired_secrets: outgoing.length },
        null,
        2,
      ),
    )
    return
  }
  console.log(`\n  client_id     ${clientId}`)
  console.log(`  client_secret ${clientSecret}`)
  console.log(`  secret_id     ${secret.id}`)
  console.log('\nOnly its SHA-256 hash is stored — copy it now, it cannot be read back.')
  if (outgoing.length > 0) {
    console.log(
      grace === 0
        ? `The ${outgoing.length} previous secret(s) were revoked and no longer authenticate anything.`
        : `The ${outgoing.length} previous secret(s) keep working for ${grace} seconds — roll the new one out before then.`,
    )
  }
}

/** Revokes one secret by id, refusing to leave a confidential client with none. */
const runRevokeSecret = async (clientId) => {
  requireApplication(clientId)
  const secretId = values['secret-id'] ?? positionals[2]
  if (!secretId) {
    fail('Which secret? Pass --secret-id, or `show <client-id>` to list them.')
  }

  const secrets = listSecrets(clientId)
  const target = secrets.find((secret) => secret.id === secretId)
  if (!target) {
    fail(`No secret ${JSON.stringify(secretId)} on ${clientId}.`)
  }
  if (target.revoked_at) {
    console.log(`${secretId} was already revoked.`)
    return
  }
  if (secrets.filter((secret) => secret.active && secret.id !== secretId).length === 0) {
    fail(
      `${secretId} is the last active secret of ${clientId}; issue a replacement with \`rotate-secret\` before revoking it.`,
    )
  }

  if (!(await confirm(`Revoke ${secretId} (${target.hint}…) on ${clientId}? Anything still using it stops working.`))) {
    console.log('Aborted.')
    return
  }

  execute(`
UPDATE application_secrets SET revoked_at = unixepoch(), updated_at = unixepoch() WHERE id = ${quote(secretId)};
${auditStatement('application.secret_revoked', { applicationId: clientId, metadata: { secret_id: secretId } })}
`)
  if (!dryRun) {
    console.log(`Revoked ${secretId} on ${clientId}.`)
  }
}

const runDelete = async (clientId) => {
  const application = requireApplication(clientId)

  // Everything keyed by the application cascades away with it, so say how much before asking.
  const [counts] = query(`
SELECT
  (SELECT COUNT(*) FROM sessions WHERE application_id = ${quote(clientId)} AND revoked_at IS NULL) AS sessions,
  (SELECT COUNT(*) FROM roles WHERE application_id = ${quote(clientId)}) AS roles,
  (SELECT COUNT(*) FROM invitations WHERE application_id = ${quote(clientId)} AND accepted_at IS NULL) AS invitations;
`)

  if (!dryRun) {
    console.log(`\nDeleting ${clientId} also deletes:`)
    console.log(`  ${counts.sessions} live session(s) and their refresh tokens`)
    console.log(`  ${counts.roles} role(s) scoped to this application, and every grant of them`)
    console.log(`  ${counts.invitations} pending invitation(s)`)
    console.log('The audit trail is kept, with its reference to this application cleared.\n')

    if (!assumeYes) {
      if (!interactive) {
        fail('Refusing to delete without confirmation. Re-run with --yes.')
      }
      const typed = await ask(`Type the client id to confirm deletion of ${clientId}`)
      if (typed !== clientId) {
        console.log('Aborted.')
        return
      }
    }
  }

  // The audit row is written first, and deliberately without `application_id`: the foreign key is
  // ON DELETE SET NULL, so keeping the id in the metadata is the only way the trail still names
  // what was removed.
  const sql = `
${auditStatement('application.deleted', { metadata: { client_id: clientId, name: application.name } })}
DELETE FROM applications WHERE id = ${quote(clientId)};
`
  execute(sql)
  if (!dryRun) {
    console.log(`Deleted ${clientId} from the ${remote ? 'remote' : 'local'} database.`)
  }
}

// ---------------------------------------------------------------------------- entrypoint

const requireClientId = () => positionals[1] ?? values['client-id'] ?? fail(`${command} needs a client id.`)

try {
  if (values.help || command === 'help') {
    console.log(USAGE)
  } else {
    switch (command) {
      case 'list':
        runList()
        break
      case 'show':
        runShow(requireClientId())
        break
      case 'create':
        await runCreate(positionals[1])
        break
      case 'update':
        await runUpdate(requireClientId())
        break
      case 'rotate-secret':
        await runRotateSecret(requireClientId())
        break
      case 'revoke-secret':
        await runRevokeSecret(requireClientId())
        break
      case 'delete':
        await runDelete(requireClientId())
        break
      default:
        fail(`Unknown command: ${command}`)
    }
  }
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`\n${error.message}`)
    process.exitCode = 1
  } else if (error?.code === 'ABORT_ERR') {
    // Ctrl+D at a prompt. Nothing has been written yet at that point — every command asks its
    // questions before it touches the database.
    console.error('\nAborted.')
    process.exitCode = 1
  } else {
    throw error
  }
} finally {
  closeReadline()
}
