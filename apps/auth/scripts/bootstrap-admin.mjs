#!/usr/bin/env node
/**
 * Bootstraps the first administrator of the auth Worker.
 *
 * Usage: `pnpm run admin:bootstrap` (local D1) or `pnpm run admin:bootstrap -- --remote`.
 *
 * Sign-up is invitation-only and there is no environment variable that bypasses it, so the very
 * first account has to be seeded into the database. This asks for an address and writes a pending,
 * global invitation carrying the `admin` role: the next magic link sent to that address goes
 * through the ordinary sign-up path, which creates the user, grants the default roles and accepts
 * the invitation. If the address already has an account, the `admin` role is granted to it
 * directly instead, since an existing user never revisits the invitation path.
 */
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'

const INVITATION_TTL_DAYS = 7

const remote = process.argv.includes('--remote')

const rl = createInterface({ input: process.stdin, output: process.stdout })
const email = (await rl.question(`Email address to make admin (${remote ? 'REMOTE' : 'local'} database): `))
  .trim()
  .toLowerCase()
rl.close()

// The address is interpolated into SQL, so anything that is not a plain email is refused rather
// than escaped. This is a one-off operator tool, but it still writes to the production database.
if (!/^[^\s'"\\;,@]+@[^\s'"\\;,@]+\.[a-z]{2,}$/.test(email)) {
  console.error(`\nNot a valid email address: ${JSON.stringify(email)}`)
  process.exit(1)
}

const sql = `
  DELETE FROM invitations WHERE email = '${email}' AND accepted_at IS NULL AND revoked_at IS NULL;

  INSERT INTO invitations (id, email, application_id, role_id, expires_at)
    SELECT '${randomUUID()}', '${email}', NULL, id, unixepoch() + ${INVITATION_TTL_DAYS * 86400}
    FROM roles WHERE slug = 'admin' AND application_id IS NULL;

  INSERT OR IGNORE INTO user_roles (user_id, role_id)
    SELECT u.id, r.id FROM users u, roles r
    WHERE u.email = '${email}' AND r.slug = 'admin' AND r.application_id IS NULL;
`

const { status } = spawnSync(
  'wrangler',
  ['d1', 'execute', 'franciscosolis_auth', remote ? '--remote' : '--local', '--command', sql],
  { stdio: 'inherit' },
)

if (status !== 0) {
  process.exit(status ?? 1)
}

console.log(`\n${email} can now sign in as admin — the invitation expires in ${INVITATION_TTL_DAYS} days.`)
