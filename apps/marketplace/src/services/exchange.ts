import type { Env } from '@/env'
import { DONATION_CURRENCY_CODES, type DonationCurrency, SETTLEMENT_CURRENCY } from '@/lib/donations'

/**
 * Exchange rates into Chilean pesos, for the one payment here that is not named in them: a general
 * donation (`src/lib/donations.ts`).
 *
 * **The source is the Banco Central de Chile**, read through the landing Worker's
 * `GET /exchange-rates` over the `LANDING` service binding. That Worker already holds the bank's token
 * and client for `/indicators`; asking it rather than the bank keeps the token in one place, and the
 * rates are the official ones a Chilean donor can check — the observed dollar for USD and the bank's
 * nominal exchange rate (pesos per unit) for every other currency.
 *
 * Cached per isolate for half an hour: the bank publishes once a business day, and the landing
 * Worker's own upstream calls are cached at the edge for an hour behind it. Neither cache is
 * load-bearing — a cold isolate simply asks again.
 */

/** The address the rates are read from. The host is a placeholder: a service binding routes by binding. */
const RATES_URL = `https://landing.internal/exchange-rates?currencies=${DONATION_CURRENCY_CODES.filter(
  (code) => code !== SETTLEMENT_CURRENCY,
).join(',')}`

/** Where the rates come from, as a donor is told. */
const RATE_SOURCE = 'Banco Central de Chile'

const CACHE_MS = 30 * 60_000

/**
 * The oldest published rate still used. The bank skips weekends and holidays, and a long weekend
 * around Fiestas Patrias leaves several days without a value — but a rate older than this means the
 * source has stopped publishing, and a donation converted at last month's rate charges somebody an
 * amount they did not choose.
 */
const MAX_AGE_DAYS = 10

type Quote = {
  /** Pesos per one unit of the currency. */
  rate: number
  /** The day the bank published it for, `YYYY-MM-DD`. Null for the peso, which needs no rate. */
  date: string | null
}

type ExchangeRates = {
  source: string
  /** Only the currencies the bank answered for. The peso is always present. */
  quotes: Partial<Record<DonationCurrency, Quote>>
}

/** Raised when there are no usable rates. A peso donation never needs any, and never sees this. */
class ExchangeRatesUnavailable extends Error {
  constructor(message = 'Exchange rates are unavailable right now') {
    super(message)
    this.name = 'ExchangeRatesUnavailable'
  }
}

type LandingAnswer = {
  data?: { rates?: { currency?: unknown; date?: unknown; value?: unknown }[] }
}

let cached: { rates: ExchangeRates; expiresAt: number } | null = null

/** Forgets the per-isolate copy. For the test suite, which shares one isolate across its files. */
const clearExchangeRateCache = () => {
  cached = null
}

const isRate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const ageInDays = (date: string, now: number) => (now - Date.parse(`${date}T00:00:00Z`)) / 86_400_000

const fetchRates = async (env: Env, now: number): Promise<ExchangeRates> => {
  let answer: LandingAnswer
  try {
    const response = await env.LANDING.fetch(RATES_URL, { headers: { Accept: 'application/json' } })
    if (!response.ok) {
      throw new Error(`the landing Worker answered ${response.status}`)
    }
    answer = (await response.json()) as LandingAnswer
  } catch (error) {
    console.error('could not read exchange rates', error instanceof Error ? error.message : error)
    throw new ExchangeRatesUnavailable()
  }

  const quotes: ExchangeRates['quotes'] = { [SETTLEMENT_CURRENCY]: { rate: 1, date: null } }
  for (const entry of answer.data?.rates ?? []) {
    const code = entry.currency
    if (
      typeof code === 'string' &&
      (DONATION_CURRENCY_CODES as readonly string[]).includes(code) &&
      code !== SETTLEMENT_CURRENCY &&
      isRate(entry.value) &&
      typeof entry.date === 'string' &&
      ISO_DATE.test(entry.date) &&
      ageInDays(entry.date, now) <= MAX_AGE_DAYS
    ) {
      quotes[code as DonationCurrency] = { rate: entry.value, date: entry.date }
    }
  }

  return { source: RATE_SOURCE, quotes }
}

/** The current rates, from the per-isolate copy when it is fresh. Throws `ExchangeRatesUnavailable`. */
const getExchangeRates = async (env: Env, now: number = Date.now()): Promise<ExchangeRates> => {
  if (cached && cached.expiresAt > now) {
    return cached.rates
  }
  const rates = await fetchRates(env, now)
  cached = { rates, expiresAt: now + CACHE_MS }
  return rates
}

/**
 * Pesos per one unit of `currency`, or null when the bank has no current rate for it.
 *
 * The peso itself is answered without asking anybody, so a donation in pesos keeps working through an
 * outage of the rate source — which is most donations, and the reason that outage costs a currency
 * picker rather than the page.
 */
const quoteFor = async (env: Env, currency: DonationCurrency): Promise<Quote | null> => {
  if (currency === SETTLEMENT_CURRENCY) {
    return { rate: 1, date: null }
  }
  return (await getExchangeRates(env)).quotes[currency] ?? null
}

export { clearExchangeRateCache, ExchangeRatesUnavailable, getExchangeRates, quoteFor, RATE_SOURCE, RATES_URL }
export type { ExchangeRates, Quote }
