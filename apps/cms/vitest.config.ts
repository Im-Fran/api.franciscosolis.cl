import { fileURLToPath } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

/**
 * The migrations are read here, on the Node side, and handed to the test Worker as a binding: the
 * suite then applies them to the isolated D1 instance of every test file. Tests therefore run
 * against the same schema production does, and a migration that does not apply cleanly fails the
 * build instead of surfacing later.
 */
const migrations = await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url)))

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          // Deliberately not the production URL. Every test stubs `fetch`, so a request that
          // escapes a stub fails against an unroutable host instead of reaching the real auth
          // Worker.
          AUTH_JWKS_URL: 'https://auth.test/.well-known/jwks.json',
          AUTH_ISSUER: 'https://auth.test',
        },
      },
    }),
  ],
  resolve: {
    alias: {
      // Wrangler reads the `@/*` mapping straight from tsconfig when it bundles; Vite does not, so
      // it has to be restated here or every `@/…` import fails to resolve under test.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Mirrors the `alias` block in wrangler.jsonc, which keeps Prettier out of the deployed
      // bundle. Restating it here is what makes the suite exercise the Worker as it actually
      // ships: a react-email upgrade that starts needing the formatter at render time fails a
      // test rather than a production send.
      'prettier/standalone': fileURLToPath(new URL('../../packages/emails/src/prettier-stub.ts', import.meta.url)),
      'prettier/plugins/html': fileURLToPath(new URL('../../packages/emails/src/prettier-stub.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    coverage: {
      // workerd exposes no V8 coverage hooks, so instrumentation is the only provider that works.
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
})
