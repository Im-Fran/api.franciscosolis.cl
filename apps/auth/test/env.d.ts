import type { D1Migration } from 'cloudflare:test'
import type { Env as WorkerEnv } from '@/env'

/**
 * Types the `env` exposed by `cloudflare:test` as this Worker's own `Env`, plus the extra binding
 * `vitest.config.ts` injects to carry the D1 migrations into the test Worker.
 */
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}

export {}
