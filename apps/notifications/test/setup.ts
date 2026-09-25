import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach } from 'vitest'

/**
 * Each test file gets its own isolated D1 instance, so the schema is created once per file from the
 * same `migrations/` directory Wrangler applies in production.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

/**
 * The pool does not roll a test back, so every test starts from empty tables. There are no foreign
 * keys in this schema, so the order does not matter.
 */
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM notifications'),
    env.DB.prepare('DELETE FROM push_subscriptions'),
    env.DB.prepare('DELETE FROM recipients'),
  ])
})
