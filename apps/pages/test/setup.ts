import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll } from 'vitest'

/**
 * Each test file gets its own isolated D1 instance, so the schema has to be created once per file
 * rather than once per run. `TEST_MIGRATIONS` is injected by `vitest.config.ts` from the same
 * `migrations/` directory Wrangler applies in production.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})
