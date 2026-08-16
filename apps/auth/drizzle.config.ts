import { defineConfig } from 'drizzle-kit'

/**
 * Only `drizzle-kit generate` is used here: it writes plain SQL into `migrations/`, which is
 * the same directory `wrangler d1 migrations apply` reads (`migrations_dir` in wrangler.jsonc).
 * That keeps migrations applied by Wrangler alone, so no D1 HTTP credentials are needed.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './migrations',
})
