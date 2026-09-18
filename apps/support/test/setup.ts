import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach } from 'vitest'
import { resetAiBindings } from './helpers/ai'

/**
 * Each test file gets its own isolated D1 instance, so the schema has to be created once per file
 * rather than once per run. `TEST_MIGRATIONS` is injected by `vitest.config.ts` from the same
 * `migrations/` directory Wrangler applies in production.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

/**
 * Workers AI and Vectorize are not declared in the `test` environment (see the comment on `env.test`
 * in wrangler.jsonc), so they arrive undefined. Installing a throwing stand-in before every test
 * means a code path that reaches either service without saying so fails with a sentence explaining
 * itself, rather than with a `TypeError` about reading a property of undefined.
 */
beforeEach(() => {
  resetAiBindings()
})
