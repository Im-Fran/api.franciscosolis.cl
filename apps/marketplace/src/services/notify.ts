import { formatMoney, resolveEmailLocale } from '@franciscosolis/emails'
import { and, eq, ne, sql } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { purchases } from '@/db/schema'
import type { Env } from '@/env'
import { ENTITLING_STATUS } from '@/lib/config'
import { isLinkedToAccount, UNLINKED_USER_ID } from '@/lib/sales'
import type { Product } from '@/services/products'
import type { Purchase } from '@/services/purchases'

/**
 * Publishing an event for `apps/notifications`, which turns it into an in-site notification, a push
 * and — for the types it may email — a message or a digest line, per the account's preferences.
 *
 * **The receipt and the refund notice are still sent from here, unchanged.** The notifications Worker
 * knows `purchase_completed` and `purchase_refunded` as not emailable, so a buyer reads the voucher
 * once in their inbox and sees the purchase once in the bell. A release or a reply to their review
 * has no mail of its own in this Worker, and is the notifications Worker's to email if they want it.
 *
 * The message shape is a contract between two Workers that deploy independently, so it is written
 * down twice on purpose: here, as what this Worker promises to send, and in `apps/notifications`, as
 * what it accepts. Only the types this Worker produces are listed.
 */
type NotificationType =
  | 'marketplace.purchase_completed'
  | 'marketplace.purchase_refunded'
  | 'marketplace.release_published'
  | 'marketplace.review_reply'

type NotificationData = Record<string, string | number | boolean | null>

type NotificationEvent = {
  version: 1
  /** Idempotency key, minted here once so a redelivered message is a no-op on the consumer. */
  id: string
  type: NotificationType
  /** The account the notification is for. `id` is the auth `sub`. */
  user: { id: string; email?: string | null; name?: string | null; locale?: string | null }
  /** ISO 8601. */
  occurred_at: string
  data: NotificationData
  /** A path on the website, starting with `/`, or null. */
  url?: string | null
}

type NotificationInput = {
  type: NotificationType
  user: NotificationEvent['user']
  data?: NotificationData
  url?: string | null
  occurredAt?: Date
}

/**
 * The most messages `sendBatch` takes in one call. A queue batch is also capped at 256 KB, which a
 * hundred of these — a few hundred bytes each — is nowhere near.
 */
const QUEUE_BATCH_LIMIT = 100

const buildNotificationEvent = (input: NotificationInput): NotificationEvent => ({
  version: 1,
  id: crypto.randomUUID(),
  type: input.type,
  user: input.user,
  occurred_at: (input.occurredAt ?? new Date()).toISOString(),
  data: input.data ?? {},
  url: input.url ?? null,
})

/**
 * The bar every event here has to clear: an account to land on. `isLinkedToAccount` is the one place
 * that knows what the sentinel of an unlinked manual sale looks like, so it is asked rather than the
 * empty string being compared here a second time.
 */
const hasAccount = (userId: string | null | undefined): userId is string => isLinkedToAccount(userId ?? null)

/**
 * Queues one event, and never throws.
 *
 * Every caller is the tail of something that already happened — money taken or returned, a release
 * gone live, a reply saved — and a webhook in particular must answer 200 or the provider retries it
 * forever. A queue that is down costs the bell, never the request.
 */
const publishNotification = async (env: Env, input: NotificationInput): Promise<boolean> => {
  if (!hasAccount(input.user.id)) {
    return false
  }
  try {
    await env.NOTIFICATIONS_QUEUE.send(buildNotificationEvent(input), { contentType: 'json' })
    return true
  } catch (error) {
    console.error('failed to publish a notification', input.type, error)
    return false
  }
}

/**
 * Queues many events in chunks `sendBatch` accepts, and never throws. Answers how many were accepted.
 *
 * A failed chunk does not stop the next one: the recipients in it are independent people, and one
 * bad call is no reason to tell the next hundred nothing.
 */
const publishNotifications = async (env: Env, inputs: NotificationInput[]): Promise<number> => {
  const events = inputs.filter((input) => hasAccount(input.user.id)).map(buildNotificationEvent)
  let accepted = 0
  for (let start = 0; start < events.length; start += QUEUE_BATCH_LIMIT) {
    const chunk = events.slice(start, start + QUEUE_BATCH_LIMIT)
    try {
      await env.NOTIFICATIONS_QUEUE.sendBatch(chunk.map((body) => ({ body, contentType: 'json' as const })))
      accepted += chunk.length
    } catch (error) {
      console.error('failed to publish a batch of notifications', chunk[0]?.type, chunk.length, error)
    }
  }
  return accepted
}

/** A product's page on the website — the same path the voucher links to. */
const productPath = (slug: string) => `/product/${slug}`

/**
 * An amount the way the receipt prints it, in the language the receipt was written in.
 *
 * `formatMoney` is the function the voucher and the refund email use, so the bell and the inbox say
 * the same thing about the same money. The contract carries it already formatted because currency is
 * this Worker's knowledge: the consumer would otherwise have to learn that CLP has no minor unit.
 */
const formatAmount = (amount: number, currency: string, locale: string | null | undefined) =>
  formatMoney(amount, currency, resolveEmailLocale(locale))

/**
 * A purchase or donation went through: the webhook approved it, or an editor recorded it by hand.
 *
 * A hand-recorded sale for an address with no account yet carries the sentinel and publishes
 * nothing; that buyer has the voucher, and a bell they cannot see would be a row nobody reads.
 */
const notifyPurchaseCompleted = async (
  env: Env,
  input: { purchase: Purchase; productName: string; locale?: string | null },
) => {
  const { purchase } = input
  return publishNotification(env, {
    type: 'marketplace.purchase_completed',
    user: { id: purchase.userId, email: purchase.email, locale: input.locale ?? null },
    occurredAt: purchase.approvedAt ?? new Date(),
    data: {
      product_name: input.productName,
      product_slug: purchase.productSlug,
      amount: formatAmount(purchase.amount, purchase.currency, input.locale),
    },
    url: '/account/purchases',
  })
}

/**
 * Money went back. The amount is what was refunded, not what was charged — a partial refund is a
 * real case, and "you were refunded $5.000" on a $10.000 sale must say $5.000.
 */
const notifyPurchaseRefunded = async (
  env: Env,
  input: { purchase: Purchase; productName: string; locale?: string | null },
) => {
  const { purchase } = input
  return publishNotification(env, {
    type: 'marketplace.purchase_refunded',
    user: { id: purchase.userId, email: purchase.email, locale: input.locale ?? null },
    occurredAt: purchase.refundedAt ?? new Date(),
    data: {
      product_name: input.productName,
      product_slug: purchase.productSlug,
      amount: formatAmount(purchase.refundedAmount ?? purchase.amount, purchase.currency, input.locale),
    },
    url: '/account/purchases',
  })
}

/**
 * Everybody who holds the product: one row per account with an approved purchase of it.
 *
 * Grouped by account rather than by purchase, because a supporter who donated three times is one
 * person who wants to hear about a release once. The address is whichever one their purchases carry —
 * any of them was verified on a token at the time — and the sentinel of an unlinked manual sale is
 * excluded in SQL, since there is nobody behind it to tell.
 */
const listProductHolders = async (db: Database, productId: string) =>
  db
    .select({ userId: purchases.userId, email: sql<string>`max(${purchases.email})` })
    .from(purchases)
    .where(
      and(
        eq(purchases.productId, productId),
        eq(purchases.status, ENTITLING_STATUS),
        ne(purchases.userId, UNLINKED_USER_ID),
      ),
    )
    .groupBy(purchases.userId)

/**
 * A release went live: told to every account that paid for or donated to the product.
 *
 * Deliberately *not* narrowed by the channel gate. A donation product may reserve its pre-release
 * lines for supporters, but that decides who may download, not who may know — and everybody on this
 * list is a supporter anyway, which is exactly who a reserved nightly is for. A free product's
 * downloaders are not on the list because a download is not a relationship: `download_events` is a
 * record of something that happened, not a subscription somebody agreed to.
 *
 * Never throws: the release is saved and audited by the time this runs, and the editor's screen must
 * not report a failure for something that already happened.
 */
const notifyReleasePublished = async (
  db: Database,
  env: Env,
  input: { product: Product; version: string; channel: string },
) => {
  try {
    const holders = await listProductHolders(db, input.product.id)
    const occurredAt = new Date()
    return await publishNotifications(
      env,
      holders.map((holder) => ({
        type: 'marketplace.release_published' as const,
        user: { id: holder.userId, email: holder.email },
        occurredAt,
        data: {
          product_name: input.product.name,
          product_slug: input.product.slug,
          version: input.version,
          channel: input.channel,
        },
        url: productPath(input.product.slug),
      })),
    )
  } catch (error) {
    console.error('failed to notify the holders of a published release', input.product.id, error)
    return 0
  }
}

/** An editor answered somebody's review: told to the account that wrote it. */
const notifyReviewReply = async (
  env: Env,
  input: { product: Product; review: { userId: string; email: string; authorName: string | null } },
) =>
  publishNotification(env, {
    type: 'marketplace.review_reply',
    user: { id: input.review.userId, email: input.review.email, name: input.review.authorName },
    data: { product_name: input.product.name, product_slug: input.product.slug },
    url: productPath(input.product.slug),
  })

export {
  buildNotificationEvent,
  notifyPurchaseCompleted,
  notifyPurchaseRefunded,
  notifyReleasePublished,
  notifyReviewReply,
  publishNotification,
  publishNotifications,
  QUEUE_BATCH_LIMIT,
}
export type { NotificationData, NotificationEvent, NotificationInput, NotificationType }
