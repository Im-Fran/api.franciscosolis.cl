import { SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readJson } from '../helpers/github'
import { SERIES, bcchError, bcchSeries, requestedUrls, stubBcch, stubFetch } from '../helpers/bcentral'

const BASE = 'https://landing.internal'

// Injected by `vitest.config.ts`; asserting on it proves `c.env` reaches the client.
const BOUND_TOKEN = 'test-bcch-token'

// Noon in Santiago on 6 October 2026, so "today" is the same date on both sides of the Andes.
const NOW = new Date('2026-10-06T15:00:00Z')
const TODAY = '2026-10-06'

const everySeries = () => ({
  [SERIES.dollar]: bcchSeries(SERIES.dollar, [
    ['2026-10-02', 931.4],
    ['2026-10-03', null],
    ['2026-10-04', null],
    ['2026-10-05', 929.87],
    ['2026-10-06', null],
  ]),
  [SERIES.uf]: bcchSeries(SERIES.uf, [
    ['2026-10-05', 39485.65],
    ['2026-10-06', 39490.12],
  ]),
  [SERIES.utm]: bcchSeries(SERIES.utm, [
    ['2026-09-01', 69542],
    ['2026-10-01', 69611],
  ]),
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('GET /indicators', () => {
  it('serves the latest value in force today of every indicator', async () => {
    stubBcch(everySeries())

    const response = await SELF.fetch(`${BASE}/indicators`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      code: 200,
      data: {
        dollar: {
          key: 'dollar',
          name: 'Observed US dollar',
          series: SERIES.dollar,
          frequency: 'daily',
          unit: 'CLP',
          date: '2026-10-05',
          value: 929.87,
        },
        uf: {
          key: 'uf',
          name: 'Unidad de Fomento (UF)',
          series: SERIES.uf,
          frequency: 'daily',
          unit: 'CLP',
          date: '2026-10-06',
          value: 39490.12,
        },
        utm: {
          key: 'utm',
          name: 'Unidad Tributaria Mensual (UTM)',
          series: SERIES.utm,
          frequency: 'monthly',
          unit: 'CLP',
          date: '2026-10-01',
          value: 69611,
        },
      },
    })
  })

  it('asks for a short window ending today in Santiago, never a future UF', async () => {
    const stub = stubBcch(everySeries())

    await SELF.fetch(`${BASE}/indicators`)

    const bySeries: Record<string, URLSearchParams> = Object.fromEntries(
      requestedUrls(stub).map((url) => [url.searchParams.get('timeseries'), url.searchParams]),
    )
    expect(Object.keys(bySeries).sort()).toEqual([SERIES.dollar, SERIES.uf, SERIES.utm].sort())
    expect(bySeries[SERIES.dollar].get('firstdate')).toBe('2026-09-21')
    expect(bySeries[SERIES.uf].get('firstdate')).toBe('2026-09-21')
    expect(bySeries[SERIES.utm].get('firstdate')).toBe('2026-08-05')
    for (const params of Object.values(bySeries)) {
      expect(params.get('lastdate')).toBe(TODAY)
      expect(params.get('token')).toBe(BOUND_TOKEN)
    }
  })

  it("uses Santiago's date late in the evening, when UTC is already tomorrow", async () => {
    vi.setSystemTime(new Date('2026-10-07T02:30:00Z'))
    const stub = stubBcch(everySeries())

    await SELF.fetch(`${BASE}/indicators`)

    for (const url of requestedUrls(stub)) {
      expect(url.searchParams.get('lastdate')).toBe(TODAY)
    }
  })

  it('may be cached by the client for half an hour', async () => {
    stubBcch(everySeries())

    const response = await SELF.fetch(`${BASE}/indicators`)

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=1800')
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=UTF-8')
  })

  it('fails as a whole, with the { code, error } envelope, when the bank rejects the token', async () => {
    stubBcch({
      [SERIES.dollar]: bcchError(),
      [SERIES.uf]: bcchError(),
      [SERIES.utm]: bcchError(),
    })

    const response = await SELF.fetch(`${BASE}/indicators`)

    expect(response.status).toBe(502)
    expect(response.headers.get('Cache-Control')).toBeNull()
    await expect(response.json()).resolves.toEqual({
      code: 502,
      error: 'Banco Central de Chile API unavailable: Invalid username or password (code -5)',
    })
  })

  it('fails rather than serving a partial set when only one series is down', async () => {
    stubBcch({ ...everySeries(), [SERIES.utm]: bcchError(-50, 'Unknown error') })

    const response = await SELF.fetch(`${BASE}/indicators`)

    expect(response.status).toBe(502)
  })

  it('refuses to answer when the window holds no published value, instead of inventing one', async () => {
    stubBcch({
      ...everySeries(),
      [SERIES.dollar]: bcchSeries(SERIES.dollar, [['2026-10-06', null]]),
    })

    const response = await SELF.fetch(`${BASE}/indicators`)

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({
      code: 502,
      error: 'Banco Central de Chile published no dollar value between 2026-09-21 and 2026-10-06',
    })
  })

  it('keeps the bound token out of every error response', async () => {
    stubFetch(async () => {
      throw new TypeError(`fetch failed: token=${BOUND_TOKEN}`)
    })

    const raw = await (await SELF.fetch(`${BASE}/indicators`)).text()

    expect(raw).not.toContain(BOUND_TOKEN)
  })
})

describe('GET /indicators/:indicator', () => {
  it('serves the last 30 days of a daily indicator by default, oldest first', async () => {
    const stub = stubBcch(everySeries())

    const response = await SELF.fetch(`${BASE}/indicators/dollar`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      code: 200,
      data: {
        key: 'dollar',
        name: 'Observed US dollar',
        series: SERIES.dollar,
        frequency: 'daily',
        unit: 'CLP',
        from: '2026-09-06',
        to: TODAY,
        observations: [
          { date: '2026-10-02', value: 931.4 },
          { date: '2026-10-05', value: 929.87 },
        ],
      },
    })
    const [url] = requestedUrls(stub)
    expect(url.searchParams.get('firstdate')).toBe('2026-09-06')
    expect(url.searchParams.get('lastdate')).toBe(TODAY)
  })

  it('serves the last year of a monthly indicator by default', async () => {
    const stub = stubBcch(everySeries())

    const body = await readJson<{ data: { from: string; to: string } }>(
      await SELF.fetch(`${BASE}/indicators/utm`),
    )

    expect(body.data).toMatchObject({ from: '2025-10-06', to: TODAY })
    expect(requestedUrls(stub)[0].searchParams.get('firstdate')).toBe('2025-10-06')
  })

  it('passes an explicit range through, future UF values included', async () => {
    const stub = stubBcch(everySeries())

    const body = await readJson<{ data: { from: string; to: string } }>(
      await SELF.fetch(`${BASE}/indicators/uf?from=2026-10-01&to=2026-11-09`),
    )

    expect(body.data).toMatchObject({ from: '2026-10-01', to: '2026-11-09' })
    const [url] = requestedUrls(stub)
    expect(url.searchParams.get('firstdate')).toBe('2026-10-01')
    expect(url.searchParams.get('lastdate')).toBe('2026-11-09')
  })

  it('counts the default window back from an explicit `to`', async () => {
    stubBcch(everySeries())

    const body = await readJson<{ data: { from: string } }>(
      await SELF.fetch(`${BASE}/indicators/uf?to=2026-03-01`),
    )

    expect(body.data.from).toBe('2026-01-30')
  })

  it('answers 200 with no observations for a range the bank has nothing for', async () => {
    stubBcch({ [SERIES.uf]: bcchSeries(SERIES.uf, []) })

    const body = await readJson<{ data: { observations: unknown[] } }>(
      await SELF.fetch(`${BASE}/indicators/uf?from=1950-01-01&to=1950-01-31`),
    )

    expect(body.data.observations).toEqual([])
  })

  it('answers 404 in the standard envelope for an unknown indicator, without calling the bank', async () => {
    const stub = stubBcch({})

    const response = await SELF.fetch(`${BASE}/indicators/euro`)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ code: 404, error: 'Unknown indicator: euro' })
    expect(stub).not.toHaveBeenCalled()
  })

  it('does not mistake an inherited object key for an indicator', async () => {
    stubBcch({})

    const response = await SELF.fetch(`${BASE}/indicators/constructor`)

    expect(response.status).toBe(404)
  })

  it.each([
    ['a malformed date', '?from=06-10-2026'],
    ['a day that does not exist', '?to=2026-02-30'],
  ])('answers 400 in the standard envelope for %s', async (_, query) => {
    const stub = stubBcch({})

    const response = await SELF.fetch(`${BASE}/indicators/uf${query}`)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      code: 400,
      error: 'Dates must be real calendar days written as YYYY-MM-DD',
    })
    expect(stub).not.toHaveBeenCalled()
  })

  it('answers 400 for a range that ends before it starts', async () => {
    stubBcch({})

    const response = await SELF.fetch(`${BASE}/indicators/uf?from=2026-10-06&to=2026-10-01`)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      code: 400,
      error: '`from` must not be after `to`',
    })
  })

  it('caps a daily range at 366 days, so one request cannot pull the whole history', async () => {
    stubBcch(everySeries())

    const allowed = await SELF.fetch(`${BASE}/indicators/dollar?from=2025-10-05&to=2026-10-06`)
    const refused = await SELF.fetch(`${BASE}/indicators/dollar?from=2025-10-04&to=2026-10-06`)

    expect(allowed.status).toBe(200)
    expect(refused.status).toBe(400)
    await expect(refused.json()).resolves.toEqual({
      code: 400,
      error: 'The range for dollar may span at most 366 days',
    })
  })

  it('allows a monthly indicator a ten-year range', async () => {
    stubBcch(everySeries())

    const allowed = await SELF.fetch(`${BASE}/indicators/utm?from=2016-10-06&to=2026-10-06`)
    const refused = await SELF.fetch(`${BASE}/indicators/utm?from=2010-01-01&to=2026-10-06`)

    expect(allowed.status).toBe(200)
    expect(refused.status).toBe(400)
  })

  it('may be cached by the client for half an hour', async () => {
    stubBcch(everySeries())

    const response = await SELF.fetch(`${BASE}/indicators/uf`)

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=1800')
  })

  it('turns an upstream failure into a 502 envelope', async () => {
    stubFetch(async () => new Response('', { status: 500 }))

    const response = await SELF.fetch(`${BASE}/indicators/uf`)

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({
      code: 502,
      error: 'Banco Central de Chile API unavailable: HTTP 500',
    })
  })
})

describe('method gating on the indicator routes', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('refuses %s without calling the bank', async (method) => {
    const stub = stubBcch(everySeries())

    for (const path of ['/indicators', '/indicators/uf']) {
      const response = await SELF.fetch(`${BASE}${path}`, { method })
      expect(response.status, `${method} ${path}`).toBe(404)
    }
    expect(stub).not.toHaveBeenCalled()
  })
})
