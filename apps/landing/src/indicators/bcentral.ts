import { HTTPException } from 'hono/http-exception'

/**
 * Client for the Banco Central de Chile statistics API (BDE "SieteRestWS"), reduced to the one
 * function this Worker uses: `GetSeries` over a date range.
 *
 * Three things about that API shape the code below:
 *
 * - **Failures arrive as HTTP 200.** A bad token, an unknown series or a malformed date answers 200
 *   with a non-zero `Codigo` and a `Descripcion`, so the status alone proves nothing.
 * - **Days without a value are still listed**: a weekend in the observed dollar comes back as an
 *   observation whose `value` is the string `"NaN"` and whose `statusCode` is `"ND"`. They are
 *   dropped here, so every observation a caller sees carries a real number.
 * - **The token travels in the query string.** It therefore never goes into an error message, and
 *   the request URL is never logged or echoed.
 */
const BCCH_ENDPOINT = 'https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx'

/**
 * How long Cloudflare's edge may reuse an upstream answer. Nothing in these series changes more than
 * once a day, and the requested range ends on today's date, so the cache key itself rolls over at
 * midnight in Santiago — the TTL only bounds how stale a same-day correction can be.
 */
const UPSTREAM_CACHE_SECONDS = 3600

type Observation = {
  date: string
  value: number
}

type BcchObservation = {
  indexDateString?: unknown
  value?: unknown
  statusCode?: unknown
}

type BcchResponse = {
  Codigo?: unknown
  Descripcion?: unknown
  Series?: { Obs?: BcchObservation[] | null } | null
}

const BCCH_DATE = /^(\d{2})-(\d{2})-(\d{4})$/

const unavailable = (detail: string) =>
  new HTTPException(502, { message: `Banco Central de Chile API unavailable: ${detail}` })

/** `DD-MM-YYYY`, the bank's date format, to `YYYY-MM-DD`. */
const toIsoDate = (value: unknown): string | null => {
  const match = typeof value === 'string' ? BCCH_DATE.exec(value) : null
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null
}

const toObservation = (raw: BcchObservation): Observation[] => {
  const date = toIsoDate(raw.indexDateString)
  const value = typeof raw.value === 'string' ? Number(raw.value) : Number.NaN
  if (raw.statusCode !== 'OK' || date === null || !Number.isFinite(value)) return []
  return [{ date, value }]
}

/**
 * Every published observation of `series` between `from` and `to` (inclusive, `YYYY-MM-DD`),
 * oldest first. An empty range is an empty array, not an error.
 */
const getSeries = async ({
  token,
  series,
  from,
  to,
}: {
  token: string
  series: string
  from: string
  to: string
}): Promise<Observation[]> => {
  if (!token) {
    throw new HTTPException(503, { message: 'Economic indicators are not configured' })
  }

  const url = new URL(BCCH_ENDPOINT)
  url.search = new URLSearchParams({
    token,
    firstdate: from,
    lastdate: to,
    timeseries: series,
    function: 'GetSeries',
  }).toString()

  let response: Response
  try {
    response = await fetch(url, {
      cf: { cacheTtl: UPSTREAM_CACHE_SECONDS, cacheEverything: true },
    })
  } catch {
    throw unavailable('request failed')
  }

  if (!response.ok) {
    throw unavailable(`HTTP ${response.status}`)
  }

  let payload: BcchResponse
  try {
    payload = await response.json()
  } catch {
    throw unavailable('unreadable response')
  }

  if (payload?.Codigo !== 0) {
    const description = typeof payload?.Descripcion === 'string' ? payload.Descripcion : 'unknown error'
    throw unavailable(`${description} (code ${String(payload?.Codigo)})`)
  }

  const observations = payload.Series?.Obs ?? []
  return observations
    .flatMap(toObservation)
    .sort((a, b) => a.date.localeCompare(b.date))
}

export { BCCH_ENDPOINT, getSeries }
export type { Observation }
