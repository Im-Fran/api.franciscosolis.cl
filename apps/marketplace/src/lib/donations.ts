import * as v from 'valibot'
import { CURRENCY } from '@/lib/pricing'

/**
 * Donations to the work in general, rather than to one product.
 *
 * Everything else that takes money here hangs off a product page: a price, a suggested amount, a
 * download it unlocks. This is the one payment that is about none of that — somebody who wants to
 * support the projects as a whole, through a link that is not a product page and grants nothing.
 * Three decisions shape it, and each is the opposite of what a product's donation does:
 *
 * - **No floor and no ceiling of ours.** A product's donation keeps `AMOUNT_LIMITS` because it sits
 *   next to a price and a suggestion; a general donation is whatever the donor chose to give. The
 *   only bounds left are structural — a positive amount, written with no more decimals than its
 *   currency has, that converts to at least one whole peso — plus whatever MercadoPago itself
 *   refuses, which the route reports as the provider's answer rather than as a rule of ours.
 * - **The donor picks the currency.** Somebody abroad thinks in dollars or euros, not in pesos.
 * - **It still settles in Chilean pesos.** This MercadoPago account is a Chilean one and Checkout Pro
 *   only charges it in CLP, so a donation named in another currency is converted at the day's rate
 *   and *charged* in pesos — the checkout shows pesos, and the donor's own bank does the conversion
 *   back. What they chose is kept beside what was charged (`pledged_amount` / `pledged_currency`), so
 *   the receipt can say both and a support conversation can be had in the donor's own terms.
 *
 * It needs no product row: `GENERAL_FUND` is the scope its sales are filed under, the same way
 * `UNLINKED_USER_ID` stands in for an account. Nothing compares against the raw id —
 * `isGeneralFund` is the one place that knows.
 */

/**
 * The scope a general donation is filed under, in the shape the back office reads a product in.
 *
 * `id` is what lands in `purchases.product_id`, and it can never collide with a product: product ids
 * are UUIDs. It is deliberately not the empty string — the filters in `services/purchases.ts` skip a
 * falsy product id, so `''` would make "the general fund's sales" mean "every sale there is".
 *
 * `name` is what a receipt prints after "the payment you made towards …", so it is the brand rather
 * than a description, and it reads the same in every language.
 */
const GENERAL_FUND = {
  id: 'general',
  slug: 'general',
  name: 'FranciscoSolis',
} as const

/** Whether a sale was a donation to the work in general rather than to one product. */
const isGeneralFund = (productId: string | null | undefined): boolean => productId === GENERAL_FUND.id

/** The page on the website that a general donation starts from and comes back to. */
const DONATE_PATH = '/donate'

/**
 * Where on the website a sale of this scope lives: the donation page for the general fund, the
 * product page for everything else. What a receipt links to and where checkout sends the donor back.
 */
const sitePathFor = (productId: string, productSlug: string): string =>
  isGeneralFund(productId) ? DONATE_PATH : `/product/${productSlug}`

/**
 * The currencies a general donation may be named in, with how many decimals each one is written in.
 *
 * A closed list rather than "any ISO code", for the same reason every other vocabulary here is one:
 * the website builds its picker from it (`GET /donations`), and a code the rate source does not quote
 * would be a currency the form offers and checkout then refuses. Adding one is an entry here.
 *
 * `minor_units` follows ISO 4217, which is what `Intl` formats by — CLP and JPY have none, the rest
 * have cents. It is what lets an amount be held as an integer of the smallest unit, so nothing here
 * holds a float: ten dollars and fifty cents is `1050` with `USD` beside it.
 */
const DONATION_CURRENCIES = {
  CLP: { name: 'Chilean peso', minor_units: 0 },
  USD: { name: 'US dollar', minor_units: 2 },
  EUR: { name: 'Euro', minor_units: 2 },
  GBP: { name: 'Pound sterling', minor_units: 2 },
  CAD: { name: 'Canadian dollar', minor_units: 2 },
  AUD: { name: 'Australian dollar', minor_units: 2 },
  CHF: { name: 'Swiss franc', minor_units: 2 },
  JPY: { name: 'Japanese yen', minor_units: 0 },
  BRL: { name: 'Brazilian real', minor_units: 2 },
  MXN: { name: 'Mexican peso', minor_units: 2 },
  ARS: { name: 'Argentine peso', minor_units: 2 },
  PEN: { name: 'Peruvian sol', minor_units: 2 },
  COP: { name: 'Colombian peso', minor_units: 2 },
  UYU: { name: 'Uruguayan peso', minor_units: 2 },
} as const satisfies Record<string, { name: string; minor_units: number }>

type DonationCurrency = keyof typeof DONATION_CURRENCIES

const DONATION_CURRENCY_CODES = Object.keys(DONATION_CURRENCIES) as DonationCurrency[]

/** The currency every donation is charged in, whatever it was named in. */
const SETTLEMENT_CURRENCY = CURRENCY

const isDonationCurrency = (value: string): value is DonationCurrency =>
  (DONATION_CURRENCY_CODES as readonly string[]).includes(value)

/** A currency code as a donor may send it. Case-insensitive on the way in, upper case from then on. */
const donationCurrencyInput = v.pipe(
  v.string(),
  v.trim(),
  v.toUpperCase(),
  v.picklist(DONATION_CURRENCY_CODES, 'That currency is not accepted for donations'),
)

/**
 * A donated amount as a donor sends it: a positive number in the currency's *major* unit.
 *
 * Whether it has more decimals than its currency allows depends on the currency, which is a second
 * field, so that half is checked by `toMinorUnits` rather than here. The upper bound is not a limit
 * on generosity — it is the largest amount an integer of cents can still hold exactly.
 */
const donationAmountInput = v.pipe(
  v.number(),
  v.finite(),
  v.gtValue(0, 'A donation has to be more than zero'),
  v.maxValue(Number.MAX_SAFE_INTEGER / 100),
)

/**
 * An amount in a currency's major unit as an integer of its minor unit, or null when it is written
 * with more decimals than the currency has (CLP 10.5, USD 1.005).
 *
 * Rounded and then compared back rather than trusted, because `10.1 * 100` is `1009.9999999999999`
 * in binary floating point — rounding is what a person meant, and the comparison is what catches the
 * third decimal they should not have typed.
 */
const toMinorUnits = (amount: number, currency: DonationCurrency): number | null => {
  const factor = 10 ** DONATION_CURRENCIES[currency].minor_units
  const minor = Math.round(amount * factor)
  return Math.abs(minor / factor - amount) < 1e-9 * Math.max(1, Math.abs(amount)) ? minor : null
}

/** The inverse, for showing an amount held in minor units. Display only; never stored. */
const fromMinorUnits = (minor: number, currency: string): number =>
  minor / 10 ** (isDonationCurrency(currency) ? DONATION_CURRENCIES[currency].minor_units : 0)

/**
 * What a donation in `currency` is charged in pesos, at `clpPerUnit` pesos to one unit of it.
 *
 * Rounded to the nearest peso, because CLP has no minor unit and Checkout Pro refuses a fraction of
 * one. A donation that rounds to nothing — a cent, in pesos — answers null: there is no checkout for
 * zero, and charging a peso for it would be charging more than the donor chose.
 */
const toSettlementAmount = (minor: number, currency: DonationCurrency, clpPerUnit: number): number | null => {
  const charged = Math.round(fromMinorUnits(minor, currency) * clpPerUnit)
  return Number.isSafeInteger(charged) && charged >= 1 ? charged : null
}

export {
  DONATE_PATH,
  DONATION_CURRENCIES,
  DONATION_CURRENCY_CODES,
  donationAmountInput,
  donationCurrencyInput,
  fromMinorUnits,
  GENERAL_FUND,
  isDonationCurrency,
  isGeneralFund,
  SETTLEMENT_CURRENCY,
  sitePathFor,
  toMinorUnits,
  toSettlementAmount,
}
export type { DonationCurrency }
