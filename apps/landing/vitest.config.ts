import { fileURLToPath } from 'node:url'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

/**
 * Tests run inside `workerd` through `@cloudflare/vitest-pool-workers`, not in Node: this Worker
 * uses the Workers runtime globals, and a Node-based test double would validate a runtime the code
 * never actually executes on.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      // The real `wrangler.jsonc` is reused so the test runtime matches production (compatibility
      // date and flags included) instead of drifting from it.
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          // Never a real token: every GitHub call is stubbed in the tests.
          GH_TOKEN: 'test-github-token',
        },
      },
    }),
  ],
  resolve: {
    // Wrangler reads the `@/*` mapping straight from tsconfig when it bundles; Vite does not, so
    // it has to be restated here or every `@/…` import fails to resolve under test.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      // workerd exposes no V8 coverage hooks, so instrumentation is the only provider that works.
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
})
