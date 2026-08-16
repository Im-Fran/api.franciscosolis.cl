import { env } from 'cloudflare:test'
import type { Env } from '@/env'

/**
 * A copy of the Worker environment with a few values replaced, for the functions that take an `Env`
 * directly. Copying instead of mutating `env` keeps a test from leaking configuration into the next
 * one; `withWorkerEnv` is the escape hatch for the cases that have to reach the Worker itself.
 */
const testEnv = (overrides: Partial<Env> = {}): Env => ({ ...env, ...overrides }) as unknown as Env

/**
 * Temporarily changes the live environment the Worker reached through `SELF` sees. The Worker runs
 * in this isolate, so it reads the very same `env` object the test holds.
 */
const withWorkerEnv = async <T>(overrides: Partial<Env>, body: () => Promise<T>): Promise<T> => {
  const mutable = env as unknown as Record<string, unknown>
  const previous = new Map(Object.keys(overrides).map((key) => [key, mutable[key]]))
  Object.assign(mutable, overrides)
  try {
    return await body()
  } finally {
    for (const [key, value] of previous) {
      mutable[key] = value
    }
  }
}

export { testEnv, withWorkerEnv }
