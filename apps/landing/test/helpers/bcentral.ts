import { vi } from 'vitest'
import type { Mock } from 'vitest'

/**
 * Doubles for the Banco Central de Chile API, shaped after what it really answers — including the
 * parts that are easy to get wrong: failures come back as HTTP 200 with a non-zero `Codigo`, dates
 * are `DD-MM-YYYY`, and a day without a value is listed as the string `"NaN"` with status `"ND"`.
 */

/** `[YYYY-MM-DD, value]`; a `null` value is a day the bank lists without publishing a number. */
type ObservationStub = [date: string, value: number | null]

const toBcchDate = (iso: string) => iso.split('-').reverse().join('-')

const bcchSeries = (series: string, observations: ObservationStub[]) => ({
  Codigo: 0,
  Descripcion: 'Success',
  Series: {
    descripEsp: 'Serie de prueba',
    descripIng: 'Test series',
    seriesId: series,
    Obs: observations.map(([date, value]) => ({
      indexDateString: toBcchDate(date),
      value: value === null ? 'NaN' : String(value),
      statusCode: value === null ? 'ND' : 'OK',
    })),
  },
  SeriesInfos: [],
})

/** Verbatim from the live API when called with a bad token. */
const bcchError = (code = -5, description = 'Invalid username or password') => ({
  Codigo: code,
  Descripcion: description,
  Series: { descripEsp: null, descripIng: null, seriesId: null, Obs: null },
  SeriesInfos: [],
})

const SERIES = {
  dollar: 'F073.TCO.PRE.Z.D',
  uf: 'F073.UFF.PRE.Z.D',
  utm: 'F073.UTR.PRE.Z.M',
} as const

/**
 * Answers every upstream call from a table keyed by series id, so a route that fans out to all three
 * series gets the right payload for each regardless of the order the calls land in.
 */
const stubBcch = (bySeries: Partial<Record<string, unknown>>) => {
  const stub = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const series = new URL(String(input)).searchParams.get('timeseries') ?? ''
    if (!(series in bySeries)) throw new Error(`Unexpected series requested: ${series}`)
    return Response.json(bySeries[series])
  })
  vi.stubGlobal('fetch', stub)
  return stub
}

const stubFetch = (
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) => {
  const stub = vi.fn(implementation)
  vi.stubGlobal('fetch', stub)
  return stub
}

/** The URLs every upstream call was made to, parsed so a test can read single parameters off them. */
const requestedUrls = (stub: Mock) => stub.mock.calls.map(([input]) => new URL(String(input)))

export { SERIES, bcchError, bcchSeries, requestedUrls, stubBcch, stubFetch }
export type { ObservationStub }
