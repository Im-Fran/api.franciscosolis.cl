import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach } from 'vitest'
import { resetAiBinding } from './helpers/ai'

/**
 * Each test file gets its own isolated D1 instance, so the schema has to be created once per file
 * rather than once per run. `TEST_MIGRATIONS` is injected by `vitest.config.ts` from the same
 * `migrations/` directory Wrangler applies in production.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

/**
 * Workers AI is supplied by assignment rather than by the `test` environment — see
 * `helpers/ai.ts`. Reinstalling the loud default before every test keeps a stub from one test
 * answering another one's call.
 */
beforeEach(() => {
  resetAiBinding()
})
