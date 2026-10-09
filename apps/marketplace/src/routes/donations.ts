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
import { clpPerUnitOf, ExchangeRatesUnavailable, getExchangeRates } from '@/services/exchange'
import { attachPreference, createPendingPurchase } from '@/services/purchases'

/**
 * The donation link: support for the work in general, rather than for one product.
 *
 * Two routes, and the split is the same one the product store makes:
 *
 * - `GET /donations` is **public and cacheable** — the currencies a donation may be named in and what
 *   one unit of each is worth in pesos today, so the page can show "≈ $9.800" while somebody types.
 * - `POST /donations/checkout` **requires** an account from `MARKETPLACE_ACCOUNT_AUDIENCES`, like every
 *   other payment here. It is what gives the donation a receipt, a place in `/me/purchases` and a
 *   donor a support conversation can find — a payment with nobody attached to it is one nobody can
 *   refund either.
 *
 * What it does *not* do is limit the amount (see `src/lib/donations.ts`), and what it cannot do is
 * charge in anything but pesos: a donation in another currency is converted here, once, and the
 * checkout is opened for the converted figure — so what the donor is shown is what they are charged.
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
})

app.get(
  '/donations',
  describeRoute({
    description:
      'What the donation link accepts: every currency a donation may be named in, with how many decimals it is written in and what one unit of it is worth in Chilean pesos today. There is no minimum and no maximum. Every donation is charged in CLP — MercadoPago settles this account in pesos — so one named in another currency is converted at checkout with the rate shown here. `clp_per_unit` is null for a currency with no rate right now; a donation in pesos never needs one. Public and cacheable.',
    tags: ['Donations'],
    responses: {
      200: {
        description: 'The donation options',
        content: {
          'application/json': {
            schema: resolver(
              v.object({
                code: v.literal(200),
                data: v.object({
                  settlement_currency: v.string(),
                  currencies: v.array(currencySchema),
                  rates_updated_at: v.nullable(v.string()),
                }),
              }),
            ),
          },
        },
      },
    },
  }),
  async (c) => {
    // An outage of the rate source costs the conversions, not the page: pesos are still quoted at 1,
    // and the website offers only the currencies it has a figure for.
    let rates: Awaited<ReturnType<typeof getExchangeRates>> | null = null
    try {
      rates = await getExchangeRates()
    } catch (error) {
      if (!(error instanceof ExchangeRatesUnavailable)) {
        throw error
      }
    }

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({
      code: 200,
      data: {
        settlement_currency: SETTLEMENT_CURRENCY,
        currencies: DONATION_CURRENCY_CODES.map((code) => ({
          code,
          name: DONATION_CURRENCIES[code].name,
          minor_units: DONATION_CURRENCIES[code].minor_units,
          clp_per_unit: code === SETTLEMENT_CURRENCY ? 1 : (rates?.clpPerUnit[code] ?? null),
        })),
        rates_updated_at: rates?.updatedAt.toISOString() ?? null,
      },
    })
  },
)

const checkoutSchema = v.object({
  /** How much, in `currency`'s major unit: `10.5` with `USD` is ten dollars and fifty cents. */
  amount: donationAmountInput,
  /** What the amount is named in. Defaults to pesos, which is what it is charged in. */
  currency: v.optional(donationCurrencyInput),
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
    checkout_url: v.string(),
  }),
})

app.post(
  '/donations/checkout',
  requireAccount,
  describeRoute({
    description:
      'Starts a donation to the projects in general — not to one product — through MercadoPago Checkout Pro, and answers the URL to send the browser to. Any amount above zero, in any currency `GET /donations` lists, written with no more decimals than that currency has. It is charged in Chilean pesos: an amount in another currency is converted at the day\'s rate here, and the answer says both what the donor chose (`pledged`) and what will be charged (`amount`). A `pending` row is written before the redirect, exactly as for a product, and the browser comes back to the donation page with `?donation=<purchase_id>` so it can poll `GET /me/purchases/:id`.',
    tags: ['Donations'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: {
        description: 'The payment was opened',
        content: { 'application/json': { schema: resolver(checkoutResponseSchema) } },
      },
      401: { description: 'Missing or invalid access token' },
      403: { description: 'The account has no verified email address' },
      422: {
        description:
          'The amount has more decimals than its currency, rounds to less than one peso, or was refused by the payment provider',
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

    let quote: Awaited<ReturnType<typeof clpPerUnitOf>>
    try {
      quote = await clpPerUnitOf(currency)
    } catch (error) {
      if (error instanceof ExchangeRatesUnavailable) {
        throw new HTTPException(503, {
          message: `There is no exchange rate for ${currency} right now. A donation in ${SETTLEMENT_CURRENCY} still works.`,
        })
      }
      throw error
    }
    if (!quote) {
      throw new HTTPException(503, {
        message: `There is no exchange rate for ${currency} right now. A donation in ${SETTLEMENT_CURRENCY} still works.`,
      })
    }

    const charged = toSettlementAmount(minor, currency, quote.rate)
    if (charged === null) {
      throw new HTTPException(422, { message: `That amount is less than one ${SETTLEMENT_CURRENCY} once converted` })
    }

    const converted = currency !== SETTLEMENT_CURRENCY
    const db = getDb(c.env)
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
      metadata: {
        product_name: GENERAL_FUND.name,
        scope: 'general',
        // The rate the charge was computed with, and how old it was. The pledge and the charge are
        // columns; this is the arithmetic between them, kept for the day somebody asks about it.
        ...(converted
          ? { exchange_rate: quote.rate, rates_updated_at: quote.updatedAt?.toISOString() ?? null }
          : {}),
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
        description: `Voluntary support for the ${GENERAL_FUND.name} projects${pledgeLabel}`,
        amount: charged,
        payerEmail: account.email,
        notificationUrl: `${c.env.MARKETPLACE_PUBLIC_URL.replace(/\/+$/, '')}/payments/mercadopago/webhook`,
        backUrls: { success: returnUrl, failure: returnUrl, pending: returnUrl },
        metadata: { purchase_id: purchase.id, product_id: GENERAL_FUND.id, kind: 'donation' },
      })
    } catch (error) {
      console.error('failed to create a MercadoPago preference for a donation', error)
      // No amount floor is ours, but MercadoPago has its own, and a 4xx from it on a preference this
      // Worker built correctly is almost always that. It is the donor's to change, so it is a 422 —
      // not an outage. The pending row stays behind either way, as in the product store.
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
          checkout_url: checkoutUrl,
        },
      },
      201,
    )
  },
)

export default app
