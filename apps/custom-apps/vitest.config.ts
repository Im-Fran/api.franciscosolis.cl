import { fileURLToPath } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// The real migrations directory, handed to each test file's isolated D1 instance by `test/setup.ts`.
const migrations = await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url)))

export default defineConfig({
  plugins: [
    cloudflareTest({
      // The top-level config, with no named `test` environment: nothing here opens a remote proxy
      // session (no `ai`), and Miniflare simulates D1, the queue and the rate limiters locally.
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          // Test-only: signs nothing outside the suite. Production and dev each have their own secret.
          UPDATE_DOWNLOAD_SECRET: 'test-update-download-secret',
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
