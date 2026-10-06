import { HTTPException } from 'hono/http-exception'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSeries } from '@/indicators/bcentral'
import { SERIES, bcchError, bcchSeries, requestedUrls, stubBcch, stubFetch } from '../helpers/bcentral'

const TOKEN = 'unit-bcch-token'
const RANGE = { token: TOKEN, series: SERIES.uf, from: '2026-09-21', to: '2026-10-06' }

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Runs `getSeries` expecting it to fail, and hands back the HTTPException it failed with. */
const failure = async (args = RANGE) => {
  const error = await getSeries(args).then(
    () => {
      throw new Error('getSeries resolved')
    },
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(HTTPException)
  return error as HTTPException
}

describe('getSeries', () => {
  it("converts the bank's DD-MM-YYYY dates and string values into ISO dates and numbers", async () => {
    stubBcch({
      [SERIES.uf]: bcchSeries(SERIES.uf, [
        ['2026-10-05', 39485.65],
        ['2026-10-06', 39490.12],
      ]),
    })

    await expect(getSeries(RANGE)).resolves.toEqual([
      { date: '2026-10-05', value: 39485.65 },
      { date: '2026-10-06', value: 39490.12 },
    ])
  })

  it('drops the days the bank lists without a value, such as a weekend in the dollar', async () => {
    stubBcch({
      [SERIES.dollar]: bcchSeries(SERIES.dollar, [
        ['2026-10-02', 931.4],
        ['2026-10-03', null],
        ['2026-10-04', null],
        ['2026-10-05', 929.87],
      ]),
    })

    await expect(getSeries({ ...RANGE, series: SERIES.dollar })).resolves.toEqual([
      { date: '2026-10-02', value: 931.4 },
      { date: '2026-10-05', value: 929.87 },
    ])
  })

  it('drops an observation whose date or value cannot be read rather than inventing one', async () => {
    const payload = bcchSeries(SERIES.uf, [['2026-10-06', 39490.12]])
    payload.Series.Obs.push(
      { indexDateString: '2026/10/07', value: '39500', statusCode: 'OK' },
      { indexDateString: '08-10-2026', value: 'not-a-number', statusCode: 'OK' },
    )
    stubBcch({ [SERIES.uf]: payload })

    await expect(getSeries(RANGE)).resolves.toEqual([{ date: '2026-10-06', value: 39490.12 }])
  })

  it('answers oldest first even if the bank does not', async () => {
    stubBcch({
      [SERIES.uf]: bcchSeries(SERIES.uf, [
        ['2026-10-06', 2],
        ['2026-10-04', 1],
      ]),
    })

    const observations = await getSeries(RANGE)

    expect(observations.map(({ date }) => date)).toEqual(['2026-10-04', '2026-10-06'])
  })

  it('treats an empty range as no observations, not as a failure', async () => {
    const empty = bcchSeries(SERIES.uf, [])
    stubBcch({ [SERIES.uf]: { ...empty, Series: { ...empty.Series, Obs: null } } })

    await expect(getSeries(RANGE)).resolves.toEqual([])
  })

  it('asks for exactly the series and range it was given, with the token', async () => {
    const stub = stubBcch({ [SERIES.uf]: bcchSeries(SERIES.uf, []) })

    await getSeries(RANGE)

    const [url] = requestedUrls(stub)
    expect(`${url.origin}${url.pathname}`).toBe('https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      token: TOKEN,
      firstdate: '2026-09-21',
      lastdate: '2026-10-06',
      timeseries: SERIES.uf,
      function: 'GetSeries',
    })
  })

  it('lets the edge cache the upstream answer', async () => {
    const stub = stubBcch({ [SERIES.uf]: bcchSeries(SERIES.uf, []) })

    await getSeries(RANGE)

    expect(stub.mock.calls[0][1]).toMatchObject({ cf: { cacheTtl: 3600, cacheEverything: true } })
  })

  it('reports an in-band failure, which the bank sends as HTTP 200, as a 502', async () => {
    stubBcch({ [SERIES.uf]: bcchError() })

    const error = await failure()

    expect(error.status).toBe(502)
    expect(error.message).toBe(
      'Banco Central de Chile API unavailable: Invalid username or password (code -5)',
    )
  })

  it('reports an HTTP failure as a 502 naming the status', async () => {
    stubFetch(async () => new Response('Service Unavailable', { status: 503 }))

    const error = await failure()

    expect(error.status).toBe(502)
    expect(error.message).toBe('Banco Central de Chile API unavailable: HTTP 503')
  })

  it('reports a transport failure as a 502', async () => {
    stubFetch(async () => {
      throw new TypeError('Network connection lost.')
    })

    const error = await failure()

    expect(error.status).toBe(502)
    expect(error.message).toBe('Banco Central de Chile API unavailable: request failed')
  })

  it('reports a body that is not JSON as a 502', async () => {
    // What the bank's error page looks like when the request is malformed enough to reach ASP.NET.
    stubFetch(async () => new Response('<html>Error</html>', { status: 200 }))

    const error = await failure()

    expect(error.status).toBe(502)
    expect(error.message).toBe('Banco Central de Chile API unavailable: unreadable response')
  })

  it('reports a JSON body without a Codigo as a failure rather than as an empty series', async () => {
    stubFetch(async () => Response.json({ unexpected: true }))

    const error = await failure()

    expect(error.message).toBe('Banco Central de Chile API unavailable: unknown error (code undefined)')
  })

  it('refuses to call the bank with no token configured', async () => {
    const stub = stubBcch({})

    const error = await failure({ ...RANGE, token: '' })

    expect(error.status).toBe(503)
    expect(error.message).toBe('Economic indicators are not configured')
    expect(stub).not.toHaveBeenCalled()
  })

  it('never puts the token in an error message, since it travels in the URL', async () => {
    for (const respond of [
      async () => Response.json(bcchError()),
      async () => new Response('', { status: 500 }),
      async () => new Response('not json'),
      async () => {
        throw new TypeError(`fetch failed: https://si3.bcentral.cl/?token=${TOKEN}`)
      },
    ]) {
      stubFetch(respond)
      expect((await failure()).message).not.toContain(TOKEN)
    }
  })
})
