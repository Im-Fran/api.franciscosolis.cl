import { fileURLToPath } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// The real migrations directory, handed to each test file's isolated D1 instance by `test/setup.ts`.
// A migration that no longer applies cleanly therefore fails the run rather than production.
const migrations = await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url)))

export default defineConfig({
  plugins: [
    cloudflareTest({
      // The `test` environment, not the top-level config. It is identical apart from leaving out the
      // `ai` and `vectorize` bindings, which this pool answers by opening a remote proxy session
      // against the real Cloudflare account — see the long comment on `env.test` in wrangler.jsonc.
      wrangler: { configPath: './wrangler.jsonc', environment: 'test' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
        },
        serviceBindings: {
          // Loud by default. A test that needs the key set stubs it explicitly with `stubJwks`;
          // anything else reaching for auth is a mistake, and a 503 says so immediately.
          AUTH: () => new Response('the AUTH service binding was not stubbed', { status: 503 }),
        },
      },
    }),
  ],
  resolve: {
    alias: {
      // Wrangler reads this from tsconfig when it bundles; Vite does not, so it has to be restated.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Same two aliases as `wrangler.jsonc`. `@react-email/render` statically imports ~1.5 MB of
      // Prettier for an option nothing here uses, and the suite has to run against the same module
      // graph the deploy does or it is testing a different program.
      'prettier/standalone': fileURLToPath(new URL('../../packages/emails/src/prettier-stub.ts', import.meta.url)),
      'prettier/plugins/html': fileURLToPath(new URL('../../packages/emails/src/prettier-stub.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    coverage: {
      // istanbul, not v8: workerd exposes no V8 coverage hooks.
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
})
