import { fileURLToPath } from 'node:url'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'
import { internalWorkers } from './test/stubs.ts'

/**
 * The gateway is nothing but its bindings, so the internal Workers it proxies to are booted alongside
 * it as auxiliary Miniflare Workers. Every binding in `wrangler.jsonc` — `LANDING`, `AUTH`, `CMS`,
 * `MARKETPLACE`, `SUPPORT` and `NOTIFICATIONS` — therefore resolves to a real service binding under
 * test, exactly as it does once deployed.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { workers: internalWorkers },
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
