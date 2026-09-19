import { renderSaleRefundEmail, resolveEmailLocale } from '@franciscosolis/emails'
import type { Env } from '@/env'
import type { RefundReason } from '@/lib/sales'
import type { Purchase } from '@/services/purchases'

/**
 * The one thing this Worker sends: a voucher, or the notice that one was refunded.
 *
 * It is deliberately far smaller than `apps/cms`' equivalent, and the difference is the point. The
 * CMS sends *editorial* mail — an editor picks a sender, fills a template and can get any of it
 * wrong — so it validates a sender allowlist and logs every message in a table. Nothing here is
 * composed by a person: the body comes from `@franciscosolis/emails`, the recipient is the address
 * on the sale, and the sender is the Worker's one configured address. A second allowlist for a
 * value no request can influence would be ceremony, and `sale_vouchers.sent_count` /`last_sent_at`
 * already answer "did it go out, and when" for the only document there is.
 *
 * Rendering is asynchronous and happens in the caller: a route that renders and then sends can
 * report which half failed, and the two failures need different words.
 */

type OutgoingEmail = {
  to: string
  subject: string
  html: string
  text: string
}

/**
 * Hands a rendered message to Cloudflare Email Sending.
 *
 * Throws on failure rather than swallowing it. Every send here is something an editor asked for and
 * is waiting on — "the voucher went out" is the answer, so a failure has to reach them rather than
 * leaving a screen that says it was sent. The one call that is *not* an editor's request (the
 * voucher issued automatically when a payment is approved) catches it deliberately, because the
 * webhook must still answer 200; see `issueVoucherForApproval`.
 */
const sendMail = async (env: Env, message: OutgoingEmail): Promise<{ messageId: string }> =>
  env.EMAIL.send({
    from: { email: env.MAIL_FROM_EMAIL, name: env.MAIL_FROM_NAME },
    to: [message.to],
    subject: message.subject,
    html: message.html,
    text: message.text,
  })

/** Renders a date the way the recipient's language writes it. Santiago, because that is where we are. */
const formatMailDate = (date: Date, locale: 'en' | 'es'): string =>
  new Intl.DateTimeFormat(locale === 'es' ? 'es-CL' : 'en-GB', {
    dateStyle: 'long',
    timeZone: 'America/Santiago',
  }).format(date)

type RefundNoticeInput = {
  purchase: Purchase
  productName: string
  reason: RefundReason
  /** Number of the voucher the refund relates to, so the two emails can be put side by side. */
  voucherNumber?: string | null
  /** Language the voucher was written in, so the notice reads like its receipt. */
  locale?: string | null
}

/**
 * Tells a buyer their money went back.
 *
 * Sent for a refund and never for a chargeback: a chargeback is the payer's bank having already
 * taken the money, so they know, and writing to tell them reads as a challenge rather than a notice.
 *
 * Unlike a voucher this throws nothing useful back at a caller — see the refund route for why: the
 * money is already returned by the time this runs, and "did the refund happen" must not become a
 * question whose answer depends on a mail binding.
 */
const sendRefundNotice = async (env: Env, input: RefundNoticeInput): Promise<void> => {
  const locale = resolveEmailLocale(input.locale)
  const rendered = await renderSaleRefundEmail({
    voucherNumber: input.voucherNumber ?? null,
    productName: input.productName,
    amount: input.purchase.refundedAmount ?? input.purchase.amount,
    currency: input.purchase.currency,
    reason: input.reason,
    refundedAt: formatMailDate(input.purchase.refundedAt ?? new Date(), locale),
    reference: input.purchase.externalReference,
    manual: input.purchase.provider !== 'mercadopago',
    locale,
    brandName: env.MAIL_FROM_NAME,
  })

  await sendMail(env, {
    to: input.purchase.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  })
}

export { formatMailDate, sendMail, sendRefundNotice }
export type { OutgoingEmail, RefundNoticeInput }
