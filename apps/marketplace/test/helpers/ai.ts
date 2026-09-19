import { env } from 'cloudflare:test'
import { vi } from 'vitest'
import type { AiBinding } from '@/env'

/**
 * Stand-in for Workers AI.
 *
 * The binding is not declared in the `test` environment of `wrangler.jsonc`, and that is not an
 * oversight — `@cloudflare/vitest-pool-workers` answers an `ai` binding by opening a remote proxy
 * session against the real Cloudflare account, which needs an API token CI does not have and bills
 * real neurons for a unit test. So the suite supplies it by assignment instead, the same way the
 * `AUTH` service binding is stubbed in `tokens.ts`.
 *
 * It defaults to throwing. A test that exercises a path reaching the model has to say what it
 * expects back, and a path that reaches it *unexpectedly* fails loudly rather than returning
 * `undefined` and being debugged three layers away.
 */

/** Installs the loud default. Called from `test/setup.ts` before every test. */
const resetAiBinding = () => {
  ;(env as { AI: AiBinding }).AI = {
    run: (() => {
      throw new Error('the AI binding was not stubbed in this test')
    }) as AiBinding['run'],
  }
}

/** Replaces `env.AI.run` with `handler`, and hands back the spy so a test can assert on the call. */
const stubAi = (handler: (model: string, input: Record<string, unknown>) => Promise<unknown>) => {
  const run = vi.fn(handler)
  ;(env as { AI: AiBinding }).AI = { run }
  return run
}

/** The common case: one canned response, whatever the model is asked. */
const stubAiResponse = (response: unknown) => stubAi(async () => response)

/** What Workers AI returns for a JSON-mode text model: the answer as a string under `response`. */
const aiTranslation = (translation: string) => ({ response: JSON.stringify({ translation }) })

export { aiTranslation, resetAiBinding, stubAi, stubAiResponse }
