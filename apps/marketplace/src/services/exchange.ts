import { DONATION_CURRENCY_CODES, type DonationCurrency, SETTLEMENT_CURRENCY } from '@/lib/donations'

/**
 * Exchange rates into Chilean pesos, for the one payment here that is not named in them: a general
 * donation (`src/lib/donations.ts`).
 *
 * **The source is ExchangeRate-API's open endpoint** — keyless, daily, and quoting every currency in
 * the donation list, CLP included. A rate for a donation does not need to be the Banco Central's to
 * the decimal: it decides how many pesos a "10 dollars" becomes, the donor sees that figure before
 * paying, and the checkout charges exactly what was shown. What it does need is to be there without
 * a secret, and the Banco Central series `apps/landing` reads are behind a token and quote the dollar
 * only.
 *
 * Quoted against the US dollar rather than the peso on purpose: the provider rounds every rate to six
 * decimals, and a peso is worth so little that its rates to a strong currency (`0.001021` dollars)
 * would keep four significant figures. Against the dollar both sides keep their precision, and pesos
 * per unit is one division.
 *
 * Two layers of caching, because the provider updates once a day and asks to be called sparingly: the
 * edge cache in front of `fetch`, and a copy per isolate. Neither is load-bearing — a cold isolate
 * simply asks again.
 */

const RATES_URL = 'https://open.er-api.com/v6/latest/USD'

/** How long one answer is reused. The provider publishes once a day; an hour is plenty fresh. */
const CACHE_SECONDS = 3_600

/**
 * The oldest quote that is still used. The provider's own update cadence is daily, so a quote three
 * days old means the source has stopped updating — and a donation converted at last month's rate
 * charges somebody an amount they did not choose.
 */
const MAX_AGE_MS = 3 * 86_400_000

type ExchangeRates = {
  /** When the provider last published these rates. */
  updatedAt: Date
  /** Pesos per one unit of each donation currency. A currency the source stopped quoting is absent. */
  clpPerUnit: Partial<Record<DonationCurrency, number>>
}

/** Raised when there are no usable rates. A peso donation never needs any, and never sees this. */
class ExchangeRatesUnavailable extends Error {
  constructor(message = 'Exchange rates are unavailable right now') {
    super(message)
    this.name = 'ExchangeRatesUnavailable'
  }
}

type ProviderAnswer = {
  result?: string
  time_last_update_unix?: number
  rates?: Record<string, number>
}

let cached: { rates: ExchangeRates; expiresAt: number } | null = null

/** Forgets the per-isolate copy. For the test suite, which shares one isolate across its files. */
const clearExchangeRateCache = () => {
  cached = null
}

const isRate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

const fetchRates = async (now: number): Promise<ExchangeRates> => {
  let answer: ProviderAnswer
  try {
    const response = await fetch(RATES_URL, {
      headers: { Accept: 'application/json' },
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    })
    if (!response.ok) {
      throw new Error(`the rate source answered ${response.status}`)
    }
    answer = (await response.json()) as ProviderAnswer
  } catch (error) {
    console.error('could not read exchange rates', error)
    throw new ExchangeRatesUnavailable()
  }

  const rates = answer.rates ?? {}
  const clpPerUsd = rates[SETTLEMENT_CURRENCY]
  const updatedAt = new Date((answer.time_last_update_unix ?? 0) * 1000)
  if (answer.result !== 'success' || !isRate(clpPerUsd) || now - updatedAt.getTime() > MAX_AGE_MS) {
    console.error('exchange rates refused', answer.result, answer.time_last_update_unix)
    throw new ExchangeRatesUnavailable()
  }

  const clpPerUnit: ExchangeRates['clpPerUnit'] = {}
  for (const code of DONATION_CURRENCY_CODES) {
    const perUsd = code === 'USD' ? 1 : rates[code]
    if (isRate(perUsd)) {
      clpPerUnit[code] = clpPerUsd / perUsd
    }
  }
  // Whatever the source says, a peso is a peso: the settlement currency never goes through a rate.
  clpPerUnit[SETTLEMENT_CURRENCY] = 1

  return { updatedAt, clpPerUnit }
}

/** The current rates, from the per-isolate copy when it is fresh. Throws `ExchangeRatesUnavailable`. */
const getExchangeRates = async (now: number = Date.now()): Promise<ExchangeRates> => {
  if (cached && cached.expiresAt > now) {
    return cached.rates
  }
  const rates = await fetchRates(now)
  cached = { rates, expiresAt: now + CACHE_SECONDS * 1000 }
  return rates
}

/**
 * Pesos per one unit of `currency`, or null when there is no rate for it.
 *
 * The peso itself is answered without asking anybody, so a donation in pesos keeps working through an
 * outage of the rate source — which is most donations, and the reason that outage costs a currency
 * picker rather than the page.
 */
const clpPerUnitOf = async (currency: DonationCurrency): Promise<{ rate: number; updatedAt: Date | null } | null> => {
  if (currency === SETTLEMENT_CURRENCY) {
    return { rate: 1, updatedAt: null }
  }
  const rates = await getExchangeRates()
  const rate = rates.clpPerUnit[currency]
  return rate === undefined ? null : { rate, updatedAt: rates.updatedAt }
}

export { clearExchangeRateCache, clpPerUnitOf, ExchangeRatesUnavailable, getExchangeRates, RATES_URL }
export type { ExchangeRates }
