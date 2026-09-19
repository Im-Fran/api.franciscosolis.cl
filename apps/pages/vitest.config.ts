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
      // The `test` environment, not the top-level config. It is identical apart from leaving out
      // the `ai` binding, which this pool answers by opening a remote proxy session against the
      // real Cloudflare account — see the long comment on `env.test` in wrangler.jsonc.
      wrangler: { configPath: './wrangler.jsonc', environment: 'test' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          // Deliberately not the production URL. Every test stubs the AUTH binding, so a request
          // that escapes a stub fails against an unroutable host instead of reaching the real auth
          // Worker.
          AUTH_JWKS_URL: 'https://auth.test/.well-known/jwks.json',
          AUTH_ISSUER: 'https://auth.test',
          // Test-only values for the three secrets this Worker holds in production. The signing key
          // is committed on purpose: it signs nothing outside the suite, exactly as the auth Worker's
          // test key does. The MercadoPago credential is a placeholder — every outbound call to the
          // provider is stubbed, and a suite that could reach the real API is a suite that can charge
          // a card.
          MERCADOPAGO_ACCESS_TOKEN: 'TEST-access-token',
          MERCADOPAGO_WEBHOOK_SECRET: 'test-webhook-secret',
          DOWNLOAD_SIGNING_KEY: 'test-download-signing-key',
          PAGES_PUBLIC_URL: 'https://api.test/pages',
          SITE_BASE_URL: 'https://site.test',
        },
        // The real binding points at the deployed `auth` Worker, which is not part of this project.
        // `stubJwks` replaces `env.AUTH` per test file; this stands in so the runtime can start at
        // all, and answers loudly rather than silently if a test forgets to stub.
        serviceBindings: {
          AUTH: () => new Response('the AUTH service binding was not stubbed', { status: 503 }),
        },
      },
    }),
  ],
  resolve: {
    alias: {
      // Wrangler reads the `@/*` mapping straight from tsconfig when it bundles; Vite does not, so
      // it has to be restated here or every `@/…` import fails to resolve under test.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
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
