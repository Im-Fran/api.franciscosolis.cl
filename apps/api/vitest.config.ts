import { fileURLToPath } from 'node:url'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'
import { internalWorkers } from './test/stubs.ts'

/**
 * The gateway is nothing but its bindings, so the three internal Workers it proxies to are booted
 * alongside it as auxiliary Miniflare Workers. `LANDING`, `AUTH` and `CMS` therefore resolve to
 * real service bindings under test, exactly as they do once deployed.
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
