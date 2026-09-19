import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { Database } from '@/db/client'
import type { AppEnv } from '@/env'
import { PAGINATION, PUBLIC_CACHE_SECONDS } from '@/lib/config'
import { createPreference } from '@/lib/mercadopago'
import { amountInput, purchaseKindFor, resolveChargeAmount } from '@/lib/pricing'
import { paginationSchema } from '@/lib/validation'
import { optionalAccount, requireAccount } from '@/middleware/account'
import type { Application } from '@/services/applications'
import { findApplicationBySlug } from '@/services/applications'
import { resolveAccess, toPublicAccess } from '@/services/access'
import { listDownloadsForAccount, toPublicDownload } from '@/services/downloads'
import {
  attachPreference,
  createPendingPurchase,
  findPurchaseById,
  listPurchasesForAccount,
  toPublicPurchase,
} from '@/services/purchases'

/**
 * The money half of a standalone application page: what it costs, whether this person has paid, how
 * they pay, and what they have bought before.
 *
 * Three different audiences share the file, and which one a route is for is the first thing to read
 * off it:
 *
 * - `GET …/pricing` is **public and cacheable** — it is the price on a product page, the same answer
 *   for everybody.
 * - `GET …/access` takes an **optional** token and is never cached. It is per person by definition.
 * - `POST …/checkout` and `/me/*` **require** an account, from `PAGES_ACCOUNT_AUDIENCES`.
 *
 * Requiring the account before checkout is what ties a payment to the SSO: there is no anonymous
 * purchase to reconcile later, and "buying creates an account" is the website signing the buyer in
 * with a magic link first — this Worker cannot create an account and must never be able to.
 */
const app = new Hono<AppEnv>()

/** Same rule as every other public read here: a draft application does not exist. */
const requirePublishedApplication = async (db: Database, slug: string): Promise<Application> => {
  const application = await findApplicationBySlug(db, slug)
  if (!application || application.status !== 'published') {
    throw new HTTPException(404, { message: 'Application not found' })
  }
  return application
}

const pricingSchema = v.looseObject({
  mode: v.string(),
  currency: v.string(),
  price: v.nullable(v.number()),
  requires_payment: v.boolean(),
})

app.get(
  '/applications/:slug/pricing',
  describeRoute({
    description:
      'What an application costs: its pricing mode, the price of a paid one, the amount a donation prefills and the smallest amount checkout accepts. Public and cacheable — it is the same answer for every visitor. Whether a *particular* person has paid is `GET /applications/:slug/access`.',
    tags: ['Store'],
    responses: {
      200: {
        description: 'The pricing of the application',
        content: { 'application/json': { schema: resolver(v.object({ code: v.literal(200), data: pricingSchema })) } },
      },
      404: { description: 'No published application with that slug' },
    },
  }),
  async (c) => {
    const application = await requirePublishedApplication(getDb(c.env), c.req.param('slug'))
    const { pricing } = await resolveAccess(getDb(c.env), application, undefined)

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({ code: 200, data: pricing })
  },
)

const accessSchema = v.looseObject({
  has_paid: v.boolean(),
  must_offer_payment: v.boolean(),
  can_download: v.boolean(),
  cooldown_seconds: v.number(),
})

app.get(
  '/applications/:slug/access',
  optionalAccount,
  describeRoute({
    description:
      'Whether the caller may download this application, and what has to be shown first. Send a Bearer access token from the website to get the answer for that account; without one the answer is the anonymous one. `must_offer_payment` is true for every non-payer of a paying application, every time — a payer gets `cooldown_seconds: 0` and the direct link instead. Never cached.',
    tags: ['Store'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The access state for this caller',
        content: { 'application/json': { schema: resolver(v.object({ code: v.literal(200), data: accessSchema })) } },
      },
      404: { description: 'No published application with that slug' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const application = await requirePublishedApplication(db, c.req.param('slug'))
    const access = await resolveAccess(db, application, c.get('account'))

    return c.json({ code: 200, data: toPublicAccess(access) })
  },
)

const checkoutSchema = v.object({
  /**
   * What to charge, in whole pesos. Only meaningful for a donation: a paid application is charged
   * its price whatever is sent, because a client that can name its own price has no price.
   */
  amount: v.optional(amountInput),
  /** Where to send the browser back to. Must be a path on the website, not a URL. */
  return_path: v.optional(v.pipe(v.string(), v.regex(/^\/[A-Za-z0-9\-._~/]{0,200}$/))),
})

const checkoutResponseSchema = v.object({
  code: v.literal(201),
  data: v.object({
    purchase_id: v.string(),
    reference: v.string(),
    amount: v.number(),
    currency: v.string(),
    /** Where the browser has to go to pay. */
    checkout_url: v.string(),
  }),
})

app.post(
  '/applications/:slug/checkout',
  requireAccount,
  describeRoute({
    description:
      'Starts a MercadoPago Checkout Pro payment for the signed-in account and answers the URL to send the browser to. A `pending` purchase row is written *before* the redirect, and its id travels as the payment\'s `external_reference` — that is how the notification later finds what was paid for. A donation may name its own `amount`; a paid application is charged its price.',
    tags: ['Store'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: {
        description: 'The payment was opened',
        content: { 'application/json': { schema: resolver(checkoutResponseSchema) } },
      },
      401: { description: 'Missing or invalid access token' },
      403: { description: 'The account has no verified email address' },
      404: { description: 'No published application with that slug' },
      409: { description: 'This account has already paid for the application' },
      422: { description: 'The application takes no payments, or the amount is out of bounds' },
      503: { description: 'Payments are not configured on this service' },
    },
  }),
  validator('json', checkoutSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const account = c.get('account')
    if (!account) {
      // Unreachable behind `requireAccount`; narrowing the optional context value rather than
      // asserting it, because the type is optional for the download routes' sake.
      throw new HTTPException(401, { message: 'A Bearer access token is required' })
    }

    const application = await requirePublishedApplication(db, c.req.param('slug'))
    const access = await resolveAccess(db, application, account)

    if (access.has_paid) {
      // A donation is a repeatable act and a purchase is not, so only the second is refused: paying
      // twice for the same application is a mistake somebody wants their money back for.
      if (access.pricing.mode === 'paid') {
        throw new HTTPException(409, { message: 'This account has already bought this application' })
      }
    }

    const charge = resolveChargeAmount(access.pricing, body.amount)
    if ('error' in charge) {
      throw new HTTPException(422, { message: charge.error })
    }

    if (!c.env.MERCADOPAGO_ACCESS_TOKEN) {
      throw new HTTPException(503, { message: 'Payments are not configured on this service' })
    }

    const kind = purchaseKindFor(access.pricing.mode)
    const purchase = await createPendingPurchase(db, {
      applicationId: application.id,
      applicationSlug: application.slug,
      kind,
      userId: account.id,
      email: account.email,
      amount: charge.amount,
      metadata: { application_name: application.name, pricing_mode: access.pricing.mode },
    })

    const site = c.env.SITE_BASE_URL.replace(/\/+$/, '')
    const returnUrl = `${site}${body.return_path ?? `/application/${application.slug}`}`

    let preference
    try {
      preference = await createPreference(c.env, {
        externalReference: purchase.externalReference,
        title: kind === 'donation' ? `Support ${application.name}` : application.name,
        description:
          kind === 'donation'
            ? `Voluntary payment for ${application.name}`
            : `Licence for ${application.name}`,
        amount: charge.amount,
        payerEmail: account.email,
        notificationUrl: `${c.env.PAGES_PUBLIC_URL.replace(/\/+$/, '')}/payments/mercadopago/webhook`,
        backUrls: { success: returnUrl, failure: returnUrl, pending: returnUrl },
        metadata: { purchase_id: purchase.id, application_id: application.id, kind },
      })
    } catch (error) {
      // The pending row is left behind on purpose: it is the record that somebody tried, and a
      // payment that arrives anyway still has something to attach itself to.
      console.error('failed to create a MercadoPago preference', error)
      throw new HTTPException(502, { message: 'The payment provider could not be reached' })
    }

    await attachPreference(db, purchase.id, preference.id)

    // `init_point` on a live credential, `sandbox_init_point` on a test one — which is what makes local
    // work possible without taking real money. A preference with neither is a provider response we do
    // not understand, and sending the browser nowhere is worse than saying so.
    const checkoutUrl = preference.init_point ?? preference.sandbox_init_point
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
          amount: charge.amount,
          currency: purchase.currency,
          checkout_url: checkoutUrl,
        },
      },
      201,
    )
  },
)

const purchaseSchema = v.looseObject({ id: v.string(), status: v.string(), active: v.boolean() })

app.get(
  '/me/purchases',
  requireAccount,
  describeRoute({
    description:
      'Everything the signed-in account has paid for, newest first: purchases and donations alike, with the status each one is in. Matched on the account id and on the verified email, so a payment made before a provider change still belongs to the person who made it.',
    tags: ['Store'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Your payments',
        content: { 'application/json': { schema: resolver(v.object({ code: v.literal(200), data: v.array(purchaseSchema) })) } },
      },
      401: { description: 'Missing or invalid access token' },
    },
  }),
  validator('query', paginationSchema),
  async (c) => {
    const { limit = PAGINATION.defaultLimit, offset = 0 } = c.req.valid('query')
    const account = c.get('account')
    if (!account) {
      throw new HTTPException(401, { message: 'A Bearer access token is required' })
    }

    const rows = await listPurchasesForAccount(getDb(c.env), account, { limit, offset })
    return c.json({ code: 200, data: rows.map(toPublicPurchase) })
  },
)

app.get(
  '/me/purchases/:id',
  requireAccount,
  describeRoute({
    description:
      'One of the signed-in account\'s payments, by id. What a page polls after coming back from MercadoPago, because the notification that settles a payment arrives on its own schedule. A payment belonging to somebody else answers 404.',
    tags: ['Store'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The payment',
        content: { 'application/json': { schema: resolver(v.object({ code: v.literal(200), data: purchaseSchema })) } },
      },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No payment of yours under that id' },
    },
  }),
  async (c) => {
    const account = c.get('account')
    if (!account) {
      throw new HTTPException(401, { message: 'A Bearer access token is required' })
    }

    const purchase = await findPurchaseById(getDb(c.env), c.req.param('id'))
    // 404 rather than 403 on somebody else's payment: a 403 confirms the id exists, and these ids are
    // handed out in URLs the buyer's browser has been through.
    if (!purchase || (purchase.userId !== account.id && purchase.email !== account.email)) {
      throw new HTTPException(404, { message: 'Payment not found' })
    }

    return c.json({ code: 200, data: toPublicPurchase(purchase) })
  },
)

app.get(
  '/me/downloads',
  requireAccount,
  describeRoute({
    description:
      'What the signed-in account has downloaded, newest first, with the version and the filename as they were at the time. Only downloads made while signed in are here — an anonymous download of a free build carries no account, by construction.',
    tags: ['Store'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Your downloads',
        content: {
          'application/json': {
            schema: resolver(v.object({ code: v.literal(200), data: v.array(v.looseObject({ id: v.string(), filename: v.string() })) })),
          },
        },
      },
      401: { description: 'Missing or invalid access token' },
    },
  }),
  validator('query', paginationSchema),
  async (c) => {
    const { limit = PAGINATION.defaultLimit, offset = 0 } = c.req.valid('query')
    const account = c.get('account')
    if (!account) {
      throw new HTTPException(401, { message: 'A Bearer access token is required' })
    }

    const rows = await listDownloadsForAccount(getDb(c.env), account.id, { limit, offset })
    return c.json({ code: 200, data: rows.map(toPublicDownload) })
  },
)

export default app
