import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { AppEnv } from '@/env'
import { PUBLIC_CACHE_SECONDS } from '@/lib/config'
import {
  DONATE_PATH,
  DONATION_CURRENCIES,
  DONATION_CURRENCY_CODES,
  donationAmountInput,
  donationCurrencyInput,
  GENERAL_FUND,
  SETTLEMENT_CURRENCY,
  toMinorUnits,
  toSettlementAmount,
} from '@/lib/donations'
import { LOCALES } from '@/lib/locales'
import { checkoutUrlFor, createPreference, MercadoPagoError, resolveEnvironment } from '@/lib/mercadopago'
import { requireAccount } from '@/middleware/account'
import { DONATION_MESSAGE_MAX, effectiveMaximum, getDonationSettings } from '@/services/donation-settings'
import {
  ExchangeRatesUnavailable,
  getExchangeRates,
  quoteFor,
  RATE_SOURCE,
  type ExchangeRates,
  type Quote,
} from '@/services/exchange'
import { attachPreference, createPendingPurchase } from '@/services/purchases'

/**
 * The donation link: support for the work in general, rather than for one product.
 *
 * Two routes, and the split is the same one the product store makes:
 *
 * - `GET /donations` is **public and cacheable** — whether the link is open, its bounds, whether it
 *   takes a message, and what one unit of each currency is worth in pesos today, so the page can show
 *   "1 USD = $978,61 → you will be charged $9.786" before anybody leaves for the checkout.
 * - `POST /donations/checkout` **requires** an account from `MARKETPLACE_ACCOUNT_AUDIENCES`, like every
 *   other payment here. It is what gives the donation a receipt, a place in `/me/purchases` and a
 *   donor a support conversation can find — a payment with nobody attached to it is one nobody can
 *   refund either.
 *
 * The bounds and the switches are the back office's (`services/donation-settings.ts`), every amount
 * in them is pesos, and they are checked against the *converted* charge. Nothing else about the
 * amount is ours to limit, and what this route cannot do is charge in anything but pesos: a donation
 * in another currency is converted here, once, at the Banco Central de Chile's rate, and the checkout
 * is opened for that figure — so what the donor is shown is what they are charged.
 *
 * After that a general donation is an ordinary `donation` row under `GENERAL_FUND`, so the webhook,
 * the receipt, the bell and the whole back office (at `/admin/products/general/…`) handle it without
 * knowing it is one.
 */
const app = new Hono<AppEnv>()

const currencySchema = v.object({
  code: v.string(),
  name: v.string(),
  minor_units: v.number(),
  clp_per_unit: v.nullable(v.number()),
  /** The day the Banco Central de Chile published that rate for. Null for the peso. */
  rate_date: v.nullable(v.string()),
})

const optionsSchema = v.object({
  /** Whether the link takes donations at all right now. */
  enabled: v.boolean(),
  settlement_currency: v.string(),
  /** Smallest charge accepted, in CLP. Null: anything from one peso. */
  minimum_amount: v.nullable(v.number()),
  /** Largest charge accepted, in CLP. Null: no ceiling. */
  maximum_amount: v.nullable(v.number()),
  /** Whether a donor may leave a message with the donation, and how long it may be. */
  messages_enabled: v.boolean(),
  message_max_length: v.number(),
  /** Where the rates come from. */
  rate_source: v.string(),
  currencies: v.array(currencySchema),
})

app.get(
  '/donations',
  describeRoute({
    description:
      'What the donation link accepts: whether it is open, the smallest and largest donation it takes (in CLP, null for none), whether a message may go with one, and every currency a donation may be named in with its decimals and what one unit is worth in Chilean pesos today. Every donation is charged in CLP — MercadoPago settles this account in pesos — so one named in another currency is converted at checkout with the Banco Central de Chile rate shown here (the observed dollar for USD, the nominal exchange rate for the rest). `clp_per_unit` is null for a currency with no current rate; a donation in pesos never needs one. Public and cacheable.',
    tags: ['Donations'],
    responses: {
      200: {
        description: 'The donation options',
        content: {
          'application/json': { schema: resolver(v.object({ code: v.literal(200), data: optionsSchema })) },
        },
      },
    },
  }),
  async (c) => {
    const settings = await getDonationSettings(getDb(c.env))

    // An outage of the rate source costs the conversions, not the page: pesos are still quoted at 1,
    // and the website offers only the currencies it has a figure for.
    let rates: ExchangeRates | null = null
    try {
      rates = await getExchangeRates(c.env)
    } catch (error) {
      if (!(error instanceof ExchangeRatesUnavailable)) {
        throw error
      }
    }

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({
      code: 200,
      data: {
        enabled: settings.enabled,
        settlement_currency: SETTLEMENT_CURRENCY,
        minimum_amount: settings.minimum_amount,
        maximum_amount: effectiveMaximum(settings),
        messages_enabled: settings.messages_enabled,
        message_max_length: DONATION_MESSAGE_MAX,
        rate_source: RATE_SOURCE,
        currencies: DONATION_CURRENCY_CODES.map((code) => {
          const quote: Quote | null = code === SETTLEMENT_CURRENCY ? { rate: 1, date: null } : (rates?.quotes[code] ?? null)
          return {
            code,
            name: DONATION_CURRENCIES[code].name,
            minor_units: DONATION_CURRENCIES[code].minor_units,
            clp_per_unit: quote?.rate ?? null,
            rate_date: quote?.date ?? null,
          }
        }),
      },
    })
  },
)

const checkoutSchema = v.object({
  /** How much, in `currency`'s major unit: `10.5` with `USD` is ten dollars and fifty cents. */
  amount: donationAmountInput,
  /** What the amount is named in. Defaults to pesos, which is what it is charged in. */
  currency: v.optional(donationCurrencyInput),
  /**
   * A note to go with the donation, read only in the back office and by the donor. Refused when the
   * link takes no messages, rather than dropped: a donor who wrote something is told it was not sent.
   */
  message: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(DONATION_MESSAGE_MAX))),
  /** Where to send the browser back to. Must be a path on the website, not a URL. */
  return_path: v.optional(v.pipe(v.string(), v.regex(/^\/[A-Za-z0-9\-._~/]{0,200}$/))),
  /** Language the donor is reading the site in, for the receipt the webhook writes later. */
  locale: v.optional(v.picklist(LOCALES)),
})

const checkoutResponseSchema = v.object({
  code: v.literal(201),
  data: v.object({
    purchase_id: v.string(),
    reference: v.string(),
    /** What will be charged, in `currency` — always CLP. */
    amount: v.number(),
    currency: v.string(),
    /** What the donor chose, when that was another currency. Null for a donation in pesos. */
    pledged: v.nullable(v.object({ amount: v.number(), currency: v.string() })),
    /** Pesos per unit of the pledged currency the charge was computed with. Null for pesos. */
    exchange_rate: v.nullable(v.number()),
    /** The day the Banco Central de Chile published that rate for. Null for pesos. */
    rate_date: v.nullable(v.string()),
    checkout_url: v.string(),
  }),
})

/** Pesos as an error message writes them, so a refused donor reads the bound they missed. */
const pesos = (amount: number) => `${SETTLEMENT_CURRENCY} ${amount.toLocaleString('es-CL')}`

app.post(
  '/donations/checkout',
  requireAccount,
  describeRoute({
    description:
      'Starts a donation to the projects in general — not to one product — through MercadoPago Checkout Pro, and answers the URL to send the browser to. Any amount in any currency `GET /donations` lists, written with no more decimals than that currency has and, once converted, inside the minimum and maximum the back office set. It is charged in Chilean pesos: an amount in another currency is converted here with the Banco Central de Chile rate, and the answer says both what the donor chose (`pledged`) and what will be charged (`amount`). A `message` is accepted only when the link takes messages. A `pending` row is written before the redirect, exactly as for a product, and the browser comes back to the donation page with `?donation=<purchase_id>` so it can poll `GET /me/purchases/:id`.',
    tags: ['Donations'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: {
        description: 'The payment was opened',
        content: { 'application/json': { schema: resolver(checkoutResponseSchema) } },
      },
      401: { description: 'Missing or invalid access token' },
      403: { description: 'The donation link is closed, or the account has no verified email address' },
      422: {
        description:
          'The amount has more decimals than its currency, is outside the configured bounds once converted, carries a message the link does not take, or was refused by the payment provider',
      },
      502: { description: 'The payment provider could not be reached' },
      503: { description: 'Payments are not configured, or there is no exchange rate for that currency right now' },
    },
  }),
  validator('json', checkoutSchema),
  async (c) => {
    const body = c.req.valid('json')
    const account = c.get('account')
    if (!account) {
      // Unreachable behind `requireAccount`; narrowed rather than asserted, as in the product store.
      throw new HTTPException(401, { message: 'A Bearer access token is required' })
    }

    const db = getDb(c.env)
    const settings = await getDonationSettings(db)
    if (!settings.enabled) {
      throw new HTTPException(403, { message: 'Donations are not being accepted right now' })
    }

    const message = body.message && body.message.length > 0 ? body.message : null
    if (message && !settings.messages_enabled) {
      throw new HTTPException(422, { message: 'Messages are not being accepted with donations right now' })
    }

    const currency = body.currency ?? SETTLEMENT_CURRENCY
    const minor = toMinorUnits(body.amount, currency)
    if (minor === null) {
      const decimals = DONATION_CURRENCIES[currency].minor_units
      throw new HTTPException(422, {
        message:
          decimals === 0
            ? `${currency} amounts are written without decimals`
            : `${currency} amounts are written with at most ${decimals} decimals`,
      })
    }

    if (!c.env.MERCADOPAGO_ACCESS_TOKEN) {
      throw new HTTPException(503, { message: 'Payments are not configured on this service' })
    }

    let quote: Quote | null
    try {
      quote = await quoteFor(c.env, currency)
    } catch (error) {
      if (!(error instanceof ExchangeRatesUnavailable)) {
        throw error
      }
      quote = null
    }
    if (!quote) {
      // A 503's body is redacted by `onError`; the page already knows which currencies have a rate.
      throw new HTTPException(503, { message: `There is no exchange rate for ${currency} right now` })
    }

    const charged = toSettlementAmount(minor, currency, quote.rate)
    if (charged === null) {
      throw new HTTPException(422, { message: `That amount is less than one ${SETTLEMENT_CURRENCY} once converted` })
    }
    if (settings.minimum_amount !== null && charged < settings.minimum_amount) {
      throw new HTTPException(422, { message: `The smallest donation accepted is ${pesos(settings.minimum_amount)}` })
    }
    const maximum = effectiveMaximum(settings)
    if (maximum !== null && charged > maximum) {
      throw new HTTPException(422, { message: `The largest donation accepted is ${pesos(maximum)}` })
    }

    const converted = currency !== SETTLEMENT_CURRENCY
    const environment = resolveEnvironment(c.env)
    const purchase = await createPendingPurchase(db, {
      productId: GENERAL_FUND.id,
      productSlug: GENERAL_FUND.slug,
      kind: 'donation',
      userId: account.id,
      email: account.email,
      amount: charged,
      environment,
      pledge: converted ? { amount: minor, currency } : null,
      donorMessage: message,
      metadata: {
        product_name: GENERAL_FUND.name,
        scope: 'general',
        // The rate the charge was computed with, where it came from and which day it was for. The
        // pledge and the charge are columns; this is the arithmetic between them.
        ...(converted ? { exchange_rate: quote.rate, rate_date: quote.date, rate_source: RATE_SOURCE } : {}),
        ...(body.locale ? { locale: body.locale } : {}),
      },
    })

    // The purchase id rides on the return URL rather than in the browser's storage: the donor may
    // finish paying in MercadoPago's app or on another device, and the page they land on still has to
    // know which payment to wait for. MercadoPago appends its own parameters after it.
    const site = c.env.SITE_BASE_URL.replace(/\/+$/, '')
    const returnUrl = `${site}${body.return_path ?? DONATE_PATH}?donation=${encodeURIComponent(purchase.id)}`
    const pledgeLabel = converted ? ` (${currency} ${body.amount.toFixed(DONATION_CURRENCIES[currency].minor_units)})` : ''

    let preference
    try {
      preference = await createPreference(c.env, {
        externalReference: purchase.externalReference,
        title: `Donation to ${GENERAL_FUND.name}`,
        description: `Voluntary donation to the ${GENERAL_FUND.name} projects, with nothing given in return${pledgeLabel}`,
        amount: charged,
        payerEmail: account.email,
        notificationUrl: `${c.env.MARKETPLACE_PUBLIC_URL.replace(/\/+$/, '')}/payments/mercadopago/webhook`,
        backUrls: { success: returnUrl, failure: returnUrl, pending: returnUrl },
        metadata: { purchase_id: purchase.id, product_id: GENERAL_FUND.id, kind: 'donation' },
      })
    } catch (error) {
      console.error('failed to create a MercadoPago preference for a donation', error)
      // MercadoPago has limits of its own, and a 4xx from it on a preference this Worker built
      // correctly is almost always one of them. It is the donor's to change, so it is a 422 — not an
      // outage. The pending row stays behind either way, as in the product store.
      if (error instanceof MercadoPagoError && error.status >= 400 && error.status < 500) {
        throw new HTTPException(422, { message: 'The payment provider did not accept this amount' })
      }
      throw new HTTPException(502, { message: 'The payment provider could not be reached' })
    }

    await attachPreference(db, purchase.id, preference.id)

    const checkoutUrl = checkoutUrlFor(preference, environment)
    if (!checkoutUrl) {
      console.error('MercadoPago returned a preference with no checkout URL', preference.id)
      throw new HTTPException(502, { message: 'The payment provider returned no checkout URL' })
    }

    return c.json(
      {
        code: 201,
        data: {
          purchase_id: purchase.id,
          reference: purchase.externalReference,
          amount: charged,
          currency: purchase.currency,
          pledged: converted ? { amount: body.amount, currency } : null,
          exchange_rate: converted ? quote.rate : null,
          rate_date: converted ? quote.date : null,
          checkout_url: checkoutUrl,
        },
      },
      201,
    )
  },
)

export default app
