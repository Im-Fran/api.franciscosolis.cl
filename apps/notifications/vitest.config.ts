import { fileURLToPath } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// The real migrations directory, handed to each test file's isolated D1 instance by `test/setup.ts`.
const migrations = await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url)))

export default defineConfig({
  plugins: [
    cloudflareTest({
      // The top-level config, with no named `test` environment: this Worker binds nothing the pool
      // would answer with a remote proxy session (no `ai`, no `vectorize`), and Miniflare simulates
      // D1, the queue consumer and the email binding locally.
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
        },
        serviceBindings: {
          // Loud by default. A test that needs the key set stubs it with `stubJwks`.
          AUTH: () => new Response('the AUTH service binding was not stubbed', { status: 503 }),
        },
      },
    }),
  ],
  resolve: {
    alias: {
      // Wrangler reads this from tsconfig when it bundles; Vite does not, so it has to be restated.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Same two aliases as `wrangler.jsonc`, so the suite runs against the module graph the deploy does.
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
