/**
 * The foreign currencies this Worker quotes in Chilean pesos, each one a Banco Central de Chile
 * series: what one unit of the currency is worth in pesos on a given day.
 *
 * The US dollar is the *observed* dollar (`F073.TCO.PRE.Z.D`), the same series `/indicators` serves
 * as `dollar`, because that is the rate Chile actually means by "the dollar". Every other currency is
 * the bank's nominal exchange rate (`F072.CLP.<code>.N.O.D`, table "Tipo de cambio nominal" in the
 * BDE), which the bank derives from that same observed dollar and its daily parities, and publishes
 * in pesos per one unit with two decimals.
 *
 * The list is the one `apps/marketplace` lets a donation be named in. A currency is added here first:
 * a code the marketplace offers and this Worker does not quote is a currency checkout can never price.
 */
const EXCHANGE_RATES = {
  USD: { name: 'US dollar (observed)', series: 'F073.TCO.PRE.Z.D' },
  EUR: { name: 'Euro', series: 'F072.CLP.EUR.N.O.D' },
  GBP: { name: 'Pound sterling', series: 'F072.CLP.GBP.N.O.D' },
  CAD: { name: 'Canadian dollar', series: 'F072.CLP.CAD.N.O.D' },
  AUD: { name: 'Australian dollar', series: 'F072.CLP.AUD.N.O.D' },
  CHF: { name: 'Swiss franc', series: 'F072.CLP.CHF.N.O.D' },
  JPY: { name: 'Japanese yen', series: 'F072.CLP.JPY.N.O.D' },
  BRL: { name: 'Brazilian real', series: 'F072.CLP.BRL.N.O.D' },
  MXN: { name: 'Mexican peso', series: 'F072.CLP.MXN.N.O.D' },
  ARS: { name: 'Argentine peso', series: 'F072.CLP.ARS.N.O.D' },
  PEN: { name: 'Peruvian sol', series: 'F072.CLP.PEN.N.O.D' },
  COP: { name: 'Colombian peso', series: 'F072.CLP.COP.N.O.D' },
  UYU: { name: 'Uruguayan peso', series: 'F072.CLP.UYU.N.O.D' },
} as const satisfies Record<string, { name: string; series: string }>

type CurrencyCode = keyof typeof EXCHANGE_RATES

const CURRENCY_CODES = Object.keys(EXCHANGE_RATES) as CurrencyCode[]

const isCurrencyCode = (code: string): code is CurrencyCode => Object.hasOwn(EXCHANGE_RATES, code)

/**
 * How far back to look for the latest published rate. Same reasoning as the observed dollar's: a
 * long weekend around Fiestas Patrias or New Year's leaves several consecutive days without one.
 */
const LATEST_LOOKBACK_DAYS = 15

export { CURRENCY_CODES, EXCHANGE_RATES, isCurrencyCode, LATEST_LOOKBACK_DAYS }
export type { CurrencyCode }
