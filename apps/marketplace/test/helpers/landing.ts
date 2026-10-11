import { env } from 'cloudflare:test'
import { vi } from 'vitest'

/**
 * Stand-in for the `LANDING` service binding, which this Worker reads exactly one thing from: the
 * Banco Central de Chile's exchange rates (`GET /exchange-rates`).
 *
 * Supplied by assignment, the way `AUTH` is in `tokens.ts` and `AI` is in `ai.ts`, and it defaults to
 * throwing for the same reason `AI` does: a path that reaches the rates unexpectedly — a donation in
 * pesos, which must never need one — fails loudly instead of quietly getting an answer.
 */

/** The landing Worker's answer, shaped like the real one. `date` defaults to yesterday. */
const exchangeRates = (rates: Record<string, number>, date = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)) => ({
  code: 200,
  data: {
    base: 'CLP',
    source: 'Banco Central de Chile',
    rates: Object.entries(rates).map(([currency, value]) => ({
      currency,
      name: currency,
      series: `TEST.${currency}`,
      date,
      value,
    })),
    missing: [],
  },
})

/** Installs the loud default. Called from `test/setup.ts` before every test. */
const resetLandingBinding = () => {
  ;(env as { LANDING: Fetcher }).LANDING = {
    fetch: (() => {
      throw new Error('the LANDING binding was not stubbed in this test')
    }) as Fetcher['fetch'],
  } as Fetcher
}

/** Answers every request to the binding with `answer`, and hands back the spy. */
const stubLanding = (answer: () => Response) => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => answer())
  ;(env as { LANDING: Fetcher }).LANDING = { fetch } as unknown as Fetcher
  return fetch
}

export { exchangeRates, resetLandingBinding, stubLanding }
