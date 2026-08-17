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
  show <client-id>            Show one client application in full
  create [<client-id>]        Register a client application (prompts for anything not given)
  update <client-id>          Change name, description, redirect URIs or status
  rotate-secret <client-id>   Issue a new client secret, printed once and never again
  delete <client-id>          Remove a client application and everything that hangs off it

Options:
  --remote                    Act on the real franciscosolis_auth database (default: local)
  --client-id <id>            Client id, lowercase alphanumeric and dashes
  --name <name>               Display name
  --description <text>        Description ("" clears it)
  --redirect-uri <url>        Redirect URI; repeat to pass several. Replaces the whole list
  --add-redirect-uri <url>    Add one redirect URI, keeping the existing ones (update only)
  --remove-redirect-uri <url> Drop one redirect URI (update only)
  --confidential              Issue a client secret (create only)
  --public                    No client secret; on update, drops the existing one
  --activate / --deactivate   Enable or disable sign-ins for the client (update only)
  --json                      Print machine-readable JSON instead of a table
  --dry-run                   Print the SQL that would run, without running it
  -y, --yes                   Skip confirmation prompts
  -h, --help                  Show this help

Examples:
  pnpm run applications -- list --remote
  pnpm run applications -- create franciscosolis-web --name "Landing" --redirect-uri https://franciscosolis.cl/auth/callback
  pnpm run applications -- update franciscosolis-cms --add-redirect-uri http://localhost:5174/auth/callback
  pnpm run applications -- rotate-secret my-backend --remote
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
  confidential: { type: 'boolean' },
  public: { type: 'boolean' },
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

/** The shape the admin API returns, so `--json` output is interchangeable with it. */
const toPublicApplication = (row) => ({
  client_id: row.id,
  name: row.name,
  description: row.description,
  confidential: row.client_secret_hash !== null,
  redirect_uris: parseRedirectUris(row.redirect_uris),
  is_active: Boolean(row.is_active),
  created_at: new Date(row.created_at * 1000).toISOString(),
  updated_at: new Date(row.updated_at * 1000).toISOString(),
})

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
  console.log(`  status        ${application.is_active ? 'active' : 'inactive'}`)
  console.log(`  created       ${application.created_at}`)
  console.log(`  updated       ${application.updated_at}`)
  console.log('  redirect URIs')
  for (const uri of application.redirect_uris) {
    console.log(`    - ${uri}`)
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
  if (asJson) {
    console.log(JSON.stringify(application, null, 2))
    return
  }
  printApplication(application)
}

const runCreate = async (positionalClientId) => {
  let clientId = positionalClientId ?? values['client-id']
  let name = values.name
  let description = values.description
  let redirectUris = values['redirect-uri'] ?? []
  // Absent flags mean "public", matching the admin API's optional `confidential`, but on a
  // terminal it is worth asking rather than quietly picking the weaker of the two.
  let confidential = values.confidential === true

  if (values.confidential === true && values.public === true) {
    fail('--confidential and --public are mutually exclusive.')
  }

  if (interactive) {
    clientId ??= await ask('client_id')
    name ??= await ask('Name', clientId)
    description ??= await ask('Description (optional)')
    while (redirectUris.length === 0) {
      const answer = await ask('Redirect URIs (comma separated)')
      redirectUris = answer.split(',').map((uri) => uri.trim()).filter(Boolean)
    }
    if (values.confidential !== true && values.public !== true) {
      confidential = await askYesNo('Confidential client (issues a client secret)?', false)
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
    confidential,
    redirect_uris: validateRedirectUris(redirectUris),
    is_active: true,
  }

  if (findApplication(clientId)) {
    fail(`${clientId} is already registered. Use \`update\` to change it.`)
  }

  const clientSecret = confidential ? randomToken(32) : null
  const sql = `
INSERT INTO applications (id, name, description, client_secret_hash, redirect_uris, is_active) VALUES (
  ${quote(application.client_id)},
  ${quote(application.name)},
  ${quote(application.description)},
  ${quote(clientSecret ? await sha256(clientSecret) : null)},
  ${quote(JSON.stringify(application.redirect_uris))},
  1
);
${auditStatement('application.created', { applicationId: application.client_id, metadata: { confidential } })}
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
  if (values.public === true) {
    if (!application.confidential) {
      fail(`${clientId} is already a public client.`)
    }
    changes.confidential = false
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
    ...(changes.is_active === undefined ? [] : [`is_active = ${changes.is_active ? 1 : 0}`]),
    ...(changes.confidential === undefined ? [] : ['client_secret_hash = NULL']),
    'updated_at = unixepoch()',
  ]

  const sql = `
UPDATE applications SET ${assignments.join(', ')} WHERE id = ${quote(clientId)};
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
  if (changes.confidential === false) {
    console.log('\nThe client secret was dropped — the client now authenticates with PKCE alone.')
  }
}

const runRotateSecret = async (clientId) => {
  const application = requireApplication(clientId)
  if (!application.confidential && values.confidential !== true) {
    fail(
      `${clientId} is a public client and has no secret. Pass --confidential to turn it into a confidential client, ` +
        'but only if it can actually keep a secret — a browser app cannot.',
    )
  }

  const label = application.confidential ? 'Rotate the client secret of' : 'Issue a first client secret for'
  if (!(await confirm(`${label} ${clientId}? Anything using the current one stops authenticating.`))) {
    console.log('Aborted.')
    return
  }

  const clientSecret = randomToken(32)
  const sql = `
UPDATE applications SET client_secret_hash = ${quote(await sha256(clientSecret))}, updated_at = unixepoch() WHERE id = ${quote(clientId)};
${auditStatement('application.secret_rotated', { applicationId: clientId, metadata: { first_secret: !application.confidential } })}
`
  execute(sql)
  if (dryRun) {
    return
  }

  if (asJson) {
    console.log(JSON.stringify({ client_id: clientId, client_secret: clientSecret }, null, 2))
    return
  }
  console.log(`\n  client_id     ${clientId}`)
  console.log(`  client_secret ${clientSecret}`)
  console.log('\nOnly its SHA-256 hash is stored — copy it now, it cannot be read back.')
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
