/**
 * The economic indicators this Worker serves, each one a Banco Central de Chile series.
 *
 * Every value is in Chilean pesos: the observed dollar is pesos per US dollar, and the UF and the
 * UTM are units of account whose value the central bank publishes in pesos. The key is the public
 * identifier (`/indicators/:indicator`); the series id is the bank's, and never leaves this file
 * except as documentation in the response.
 */
const FREQUENCIES = {
  daily: {
    // Long enough to cover the longest run of days without a published observed dollar: a long
    // weekend around Fiestas Patrias or New Year's leaves several consecutive days blank.
    latestLookbackDays: 15,
    defaultSpanDays: 30,
    maxSpanDays: 366,
  },
  monthly: {
    // Two months back always contains the current month's observation, dated the 1st, and the
    // previous one in case the current month has not been published yet.
    latestLookbackDays: 62,
    defaultSpanDays: 365,
    maxSpanDays: 3660,
  },
} as const

type Frequency = keyof typeof FREQUENCIES

type Indicator = {
  name: string
  series: string
  frequency: Frequency
  unit: 'CLP'
}

const INDICATORS = {
  dollar: {
    name: 'Observed US dollar',
    series: 'F073.TCO.PRE.Z.D',
    frequency: 'daily',
    unit: 'CLP',
  },
  uf: {
    name: 'Unidad de Fomento (UF)',
    series: 'F073.UFF.PRE.Z.D',
    frequency: 'daily',
    unit: 'CLP',
  },
  utm: {
    name: 'Unidad Tributaria Mensual (UTM)',
    series: 'F073.UTR.PRE.Z.M',
    frequency: 'monthly',
    unit: 'CLP',
  },
} as const satisfies Record<string, Indicator>

type IndicatorKey = keyof typeof INDICATORS

const INDICATOR_KEYS = Object.keys(INDICATORS) as IndicatorKey[]

const isIndicatorKey = (key: string): key is IndicatorKey => Object.hasOwn(INDICATORS, key)

export { FREQUENCIES, INDICATORS, INDICATOR_KEYS, isIndicatorKey }
export type { Frequency, Indicator, IndicatorKey }
