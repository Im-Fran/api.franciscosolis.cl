import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { Env } from '@/env'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getSeries } from '@/indicators/bcentral'
import { daysBetween, isIsoDate, santiagoToday, shiftDays } from '@/indicators/dates'
import { FREQUENCIES, INDICATORS, INDICATOR_KEYS, isIndicatorKey } from '@/indicators/registry'
import type { IndicatorKey } from '@/indicators/registry'

const app = new Hono<{ Bindings: Env }>()

/**
 * Half an hour: short enough that the UF rolling over at midnight is visible soon after, long enough
 * that a landing page under load is not one upstream call per visitor.
 */
const PUBLIC_CACHE_SECONDS = 1800

const indicatorMetaSchema = {
  key: v.picklist(INDICATOR_KEYS),
  name: v.string(),
  series: v.string(),
  frequency: v.picklist(['daily', 'monthly']),
  unit: v.literal('CLP'),
}

const latestSchema = v.object({
  ...indicatorMetaSchema,
  date: v.string(),
  value: v.number(),
})

const indexResponseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    dollar: latestSchema,
    uf: latestSchema,
    utm: latestSchema,
  }),
})

const historyResponseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    ...indicatorMetaSchema,
    from: v.string(),
    to: v.string(),
    observations: v.array(v.object({ date: v.string(), value: v.number() })),
  }),
})

const isoDate = v.pipe(
  v.string(),
  v.check(isIsoDate, 'Dates must be real calendar days written as YYYY-MM-DD'),
)

const historyQuerySchema = v.object({
  from: v.optional(isoDate),
  to: v.optional(isoDate),
})

const meta = (key: IndicatorKey) => ({ key, ...INDICATORS[key] })

/**
 * The most recent observation in force today. The range ends on today's date in Santiago because
 * the UF is published weeks ahead: without an upper bound the newest observation would be a future
 * value, not the one that applies today.
 */
const getLatest = async (token: string, key: IndicatorKey) => {
  const { series, frequency } = INDICATORS[key]
  const to = santiagoToday()
  const from = shiftDays(to, -FREQUENCIES[frequency].latestLookbackDays)

  const observations = await getSeries({ token, series, from, to })
  const latest = observations.at(-1)
  if (!latest) {
    throw new HTTPException(502, {
      message: `Banco Central de Chile published no ${key} value between ${from} and ${to}`,
    })
  }

  return { ...meta(key), ...latest }
}

app.get(
  '/',
  describeRoute({
    description:
      'Latest value in force today of each economic indicator, from the Banco Central de Chile: the observed US dollar (pesos per dollar), the UF and the UTM, all in Chilean pesos.',
    tags: ['Indicators'],
    responses: {
      200: {
        description: 'Latest value of every indicator',
        content: { 'application/json': { schema: resolver(indexResponseSchema) } },
      },
      502: { description: 'The Banco Central de Chile API failed or published nothing recent' },
    },
  }),
  async (c) => {
    const token = c.env.BCCH_API_TOKEN
    const [dollar, uf, utm] = await Promise.all([
      getLatest(token, 'dollar'),
      getLatest(token, 'uf'),
      getLatest(token, 'utm'),
    ])

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({ code: 200, data: { dollar, uf, utm } })
  },
)

app.get(
  '/:indicator',
  describeRoute({
    description:
      'Published observations of one economic indicator between `from` and `to` (inclusive, YYYY-MM-DD), oldest first. `to` defaults to today in Santiago and `from` to 30 days (daily series) or a year (monthly series) before it. Days without a published value, such as weekends for the dollar, are omitted. A range longer than 366 days (daily) or 3660 days (monthly) is refused.',
    tags: ['Indicators'],
    responses: {
      200: {
        description: 'Observations of the indicator',
        content: { 'application/json': { schema: resolver(historyResponseSchema) } },
      },
      400: { description: 'Invalid or too long date range' },
      404: { description: 'No such indicator' },
      502: { description: 'The Banco Central de Chile API failed' },
    },
  }),
  validator('query', historyQuerySchema, (result) => {
    if (!result.success) {
      throw new HTTPException(400, {
        message: result.error.map((issue) => issue.message).join('; '),
      })
    }
  }),
  async (c) => {
    const key = c.req.param('indicator')
    if (!isIndicatorKey(key)) {
      throw new HTTPException(404, { message: `Unknown indicator: ${key}` })
    }

    const { frequency, series } = INDICATORS[key]
    const { defaultSpanDays, maxSpanDays } = FREQUENCIES[frequency]
    const query = c.req.valid('query')
    const to = query.to ?? santiagoToday()
    const from = query.from ?? shiftDays(to, -defaultSpanDays)

    const span = daysBetween(from, to)
    if (span < 0) {
      throw new HTTPException(400, { message: '`from` must not be after `to`' })
    }
    if (span > maxSpanDays) {
      throw new HTTPException(400, {
        message: `The range for ${key} may span at most ${maxSpanDays} days`,
      })
    }

    const observations = await getSeries({ token: c.env.BCCH_API_TOKEN, series, from, to })

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({ code: 200, data: { ...meta(key), from, to, observations } })
  },
)

export default app
