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
          // The real address rather than a `.test` one: Miniflare enforces the
          // `allowed_sender_addresses` list from wrangler.jsonc, and a sender outside it throws
          // inside the binding — which the voucher path catches, leaving a suite that passes while
          // printing an uncaught exception per approved payment. A test that cares what was sent
          // replaces `env.EMAIL` with a spy instead.
          MAIL_FROM_EMAIL: 'no-reply@mail.franciscosolis.cl',
          MAIL_FROM_NAME: 'FranciscoSolis (test)',
          // `sandbox` under test for the same reason the credential is a placeholder: nothing in the
          // suite may look like the live account. A test that cares which checkout URL is handed
          // back overrides it per file.
          MERCADOPAGO_ENVIRONMENT: 'sandbox',
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
      // Mirrors the `alias` block in wrangler.jsonc, which keeps Prettier out of the deployed
      // bundle. Restating it here is what makes the suite exercise the Worker as it actually ships:
      // a react-email upgrade that starts needing the formatter at render time fails a test rather
      // than a production send.
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
