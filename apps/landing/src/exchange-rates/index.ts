import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import type { Env } from '@/env'
import { getSeries } from '@/indicators/bcentral'
import { santiagoToday, shiftDays } from '@/indicators/dates'
import {
  CURRENCY_CODES,
  EXCHANGE_RATES,
  isCurrencyCode,
  LATEST_LOOKBACK_DAYS,
  type CurrencyCode,
} from '@/exchange-rates/registry'

/**
 * What one unit of each foreign currency is worth in Chilean pesos today, from the Banco Central de
 * Chile.
 *
 * Its caller is `apps/marketplace`, which prices a donation named in dollars or euros in the pesos
 * MercadoPago actually charges, over a service binding — but it is an ordinary read, so the gateway
 * serves it at `/landing/exchange-rates` like everything else here.
 *
 * Two things shape it:
 *
 * - **A currency the bank could not answer for is reported, not fatal.** Each rate is its own series
 *   and its own request; one failing leaves the others usable, and it is listed under `missing` so a
 *   caller can stop offering that currency rather than losing all of them. Only when *every* rate
 *   fails is it a 502.
 * - **The bank allows five requests a second per user**, and each currency is one request. The calls
 *   are therefore made in batches that respect that ceiling instead of all at once — which only costs
 *   anything on a cold edge cache, because `getSeries` lets Cloudflare reuse an upstream answer for an
 *   hour.
 */
const app = new Hono<{ Bindings: Env }>()

/** Half an hour, as for `/indicators`: the rates change once a day. */
const PUBLIC_CACHE_SECONDS = 1800

/** The bank's published ceiling is five requests a second per user; four leaves room for `/indicators`. */
const BATCH_SIZE = 4
const BATCH_INTERVAL_MS = 1_000

const rateSchema = v.object({
  currency: v.string(),
  name: v.string(),
  series: v.string(),
  /** The day the rate was published for, `YYYY-MM-DD`. */
  date: v.string(),
  /** Pesos per one unit of `currency`. */
  value: v.number(),
})

const responseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    base: v.literal('CLP'),
    source: v.string(),
    rates: v.array(rateSchema),
    /** Currencies the bank published nothing for in the lookback window, or whose request failed. */
    missing: v.array(v.string()),
  }),
})

const querySchema = v.object({
  /** Comma-separated codes to quote, e.g. `USD,EUR`. Every supported currency when omitted. */
  currencies: v.optional(v.string()),
})

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Runs `task` over `items` at most `size` at a time, starting a batch no sooner than `intervalMs` after the last. */
const inBatches = async <T, R>(items: readonly T[], size: number, intervalMs: number, task: (item: T) => Promise<R>) => {
  const results: R[] = []
  for (let start = 0; start < items.length; start += size) {
    const began = Date.now()
    results.push(...(await Promise.all(items.slice(start, start + size).map(task))))
    const elapsed = Date.now() - began
    if (start + size < items.length && elapsed < intervalMs) {
      await pause(intervalMs - elapsed)
    }
  }
  return results
}

const latestRate = async (token: string, currency: CurrencyCode) => {
  const { name, series } = EXCHANGE_RATES[currency]
  const to = santiagoToday()
  const from = shiftDays(to, -LATEST_LOOKBACK_DAYS)
  try {
    const latest = (await getSeries({ token, series, from, to })).at(-1)
    return latest ? { currency, name, series, ...latest } : null
  } catch (error) {
    // A missing token is a configuration problem for every currency alike, so it is not "missing".
    if (error instanceof HTTPException && error.status === 503) {
      throw error
    }
    console.error('exchange rate unavailable', currency, error instanceof Error ? error.message : error)
    return null
  }
}

app.get(
  '/',
  describeRoute({
    description:
      'What one unit of each supported foreign currency is worth in Chilean pesos, from the Banco Central de Chile: the observed dollar for USD and the nominal exchange rate (`F072.CLP.<code>.N.O.D`) for the rest, each as the latest published value in force today. `?currencies=USD,EUR` narrows the list. A currency the bank published nothing for is listed under `missing` rather than failing the request.',
    tags: ['Indicators'],
    responses: {
      200: {
        description: 'The latest rate of every requested currency',
        content: { 'application/json': { schema: resolver(responseSchema) } },
      },
      400: { description: 'An unsupported currency code was requested' },
      502: { description: 'The Banco Central de Chile API answered for none of the currencies' },
      503: { description: 'Economic indicators are not configured' },
    },
  }),
  validator('query', querySchema),
  async (c) => {
    const { currencies } = c.req.valid('query')
    const requested = currencies
      ? [...new Set(currencies.split(',').map((code) => code.trim().toUpperCase()).filter(Boolean))]
      : CURRENCY_CODES
    const unknown = requested.filter((code) => !isCurrencyCode(code))
    if (unknown.length > 0) {
      throw new HTTPException(400, { message: `Unsupported currency: ${unknown.join(', ')}` })
    }

    const codes = requested as CurrencyCode[]
    const results = await inBatches(codes, BATCH_SIZE, BATCH_INTERVAL_MS, (code) =>
      latestRate(c.env.BCCH_API_TOKEN, code),
    )
    const rates = results.filter((rate): rate is NonNullable<typeof rate> => rate !== null)
    if (codes.length > 0 && rates.length === 0) {
      throw new HTTPException(502, { message: 'Banco Central de Chile published no exchange rate' })
    }

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({
      code: 200,
      data: {
        base: 'CLP' as const,
        source: 'Banco Central de Chile',
        rates,
        missing: codes.filter((code) => !rates.some((rate) => rate.currency === code)),
      },
    })
  },
)

export default app
