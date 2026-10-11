import { SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bcchError, bcchSeries, requestedUrls, stubBcch, stubFetch } from '../helpers/bcentral'

const BASE = 'https://landing.internal'

// Noon in Santiago on 6 October 2026, as in `indicators.test.ts`.
const NOW = new Date('2026-10-06T15:00:00Z')

const USD = 'F073.TCO.PRE.Z.D'
const EUR = 'F072.CLP.EUR.N.O.D'
const JPY = 'F072.CLP.JPY.N.O.D'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

type RatesBody = {
  data: {
    base: string
    source: string
    rates: { currency: string; series: string; date: string; value: number }[]
    missing: string[]
  }
}

describe('GET /exchange-rates', () => {
  it('quotes the observed dollar for USD and the nominal rate for the rest, in pesos', async () => {
    const stub = stubBcch({
      [USD]: bcchSeries(USD, [
        ['2026-10-05', 978.61],
        ['2026-10-06', null],
      ]),
      [EUR]: bcchSeries(EUR, [['2026-10-05', 1095.5]]),
    })

    const response = await SELF.fetch(`${BASE}/exchange-rates?currencies=usd,EUR`)
    const body = (await response.json()) as RatesBody

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=1800')
    expect(body.data).toMatchObject({ base: 'CLP', source: 'Banco Central de Chile', missing: [] })
    expect(body.data.rates).toEqual([
      expect.objectContaining({ currency: 'USD', series: USD, date: '2026-10-05', value: 978.61 }),
      expect.objectContaining({ currency: 'EUR', series: EUR, date: '2026-10-05', value: 1095.5 }),
    ])
    expect(requestedUrls(stub).map((url) => url.searchParams.get('timeseries'))).toEqual([USD, EUR])
  })

  it('lists a currency the bank could not answer for as missing, and keeps the rest', async () => {
    stubBcch({
      [USD]: bcchSeries(USD, [['2026-10-05', 978.61]]),
      [JPY]: bcchError(-50, 'Invalid series'),
    })

    const response = await SELF.fetch(`${BASE}/exchange-rates?currencies=USD,JPY`)
    const body = (await response.json()) as RatesBody

    expect(response.status).toBe(200)
    expect(body.data.rates.map((rate) => rate.currency)).toEqual(['USD'])
    expect(body.data.missing).toEqual(['JPY'])
  })

  it('answers 502 when the bank answers for none of them', async () => {
    stubFetch(async () => Response.json(bcchError()))

    const response = await SELF.fetch(`${BASE}/exchange-rates?currencies=USD`)

    expect(response.status).toBe(502)
  })

  it('refuses a currency it does not quote', async () => {
    stubFetch(async () => {
      throw new Error('no upstream call expected')
    })

    const response = await SELF.fetch(`${BASE}/exchange-rates?currencies=USD,XYZ`)

    expect(response.status).toBe(400)
  })

  it('quotes every supported currency when none is named, in batches the bank allows', async () => {
    const stub = stubFetch(async (input) => {
      const series = new URL(String(input)).searchParams.get('timeseries') ?? ''
      return Response.json(bcchSeries(series, [['2026-10-05', 100]]))
    })

    const response = await SELF.fetch(`${BASE}/exchange-rates`)
    const body = (await response.json()) as RatesBody

    expect(response.status).toBe(200)
    expect(body.data.rates).toHaveLength(13)
    expect(body.data.missing).toEqual([])
    expect(stub).toHaveBeenCalledTimes(13)
  }, 15_000)
})
