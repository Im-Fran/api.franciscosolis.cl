import { env } from 'cloudflare:test'
import { vi } from 'vitest'
import type { AiBinding, VectorizeBinding } from '@/env'

/**
 * Stand-ins for Workers AI and Vectorize.
 *
 * Neither binding is declared in the `test` environment of `wrangler.jsonc`, and that is not an
 * oversight — `@cloudflare/vitest-pool-workers` answers either of them by opening a remote proxy
 * session against the real Cloudflare account, which needs an API token CI does not have and bills
 * real neurons for a unit test. So the suite supplies both by assignment instead, the same way the
 * `AUTH` service binding is stubbed in `tokens.ts`.
 *
 * Both default to throwing. A test that exercises a path reaching either service has to say what it
 * expects back, and a path that reaches one *unexpectedly* fails loudly instead of returning
 * `undefined` and being debugged three layers away.
 */

const notStubbed = (name: string) => () => {
  throw new Error(`the ${name} binding was not stubbed in this test`)
}

/** Installs the loud defaults. Called from `test/setup.ts` before every test. */
const resetAiBindings = () => {
  ;(env as { AI: AiBinding }).AI = { run: notStubbed('AI') as AiBinding['run'] }
  ;(env as { VECTORIZE: VectorizeBinding }).VECTORIZE = {
    query: notStubbed('VECTORIZE') as VectorizeBinding['query'],
    upsert: notStubbed('VECTORIZE') as VectorizeBinding['upsert'],
    deleteByIds: notStubbed('VECTORIZE') as VectorizeBinding['deleteByIds'],
  }
}

/** Replaces `env.AI.run` with `handler`, and hands back the spy so a test can assert on the call. */
const stubAi = (handler: (model: string, input: Record<string, unknown>) => Promise<unknown>) => {
  const run = vi.fn(handler)
  ;(env as { AI: AiBinding }).AI = { run }
  return run
}

/** The common case: one model, one canned response, whatever it is asked. */
const stubAiResponse = (response: unknown) => stubAi(async () => response)

/** Replaces the Vectorize binding. Anything left out keeps its loud default. */
const stubVectorize = (overrides: Partial<VectorizeBinding>) => {
  const binding = {
    query: overrides.query ?? (notStubbed('VECTORIZE.query') as VectorizeBinding['query']),
    upsert: overrides.upsert ?? vi.fn(async () => ({ mutationId: 'test' })),
    deleteByIds: overrides.deleteByIds ?? vi.fn(async () => ({ mutationId: 'test' })),
  }
  ;(env as { VECTORIZE: VectorizeBinding }).VECTORIZE = binding
  return binding
}

export { resetAiBindings, stubAi, stubAiResponse, stubVectorize }
