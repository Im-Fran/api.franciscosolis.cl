/** @jsxImportSource react */
import { DetailRows } from '../components/detail-rows'
import { EmailLayout } from '../components/email-layout'
import { Paragraph } from '../components/paragraph'
import type { EmailLocale } from '../locale'
import { formatMoney } from '../money'
import { renderEmail, type RenderedEmail } from '../render'

/** Why the money went back, as `apps/pages` records it on the sale. */
type RefundReason = 'withdrawal' | 'duplicate' | 'not_delivered' | 'goodwill' | 'fraud' | 'other'

type SaleRefundEmailProps = {
  /** Voucher number of the sale being refunded, so the two emails can be put side by side. */
  voucherNumber: string | null
  applicationName: string
  /** What was given back. A partial refund is why this is not simply the sale's amount. */
  amount: number
  currency: string
  reason: RefundReason
  /** Already formatted by the sender; this template does no date work. */
  refundedAt: string
  reference: string
  /** Whether the payment went back through the provider or was settled by hand (cash, transfer). */
  manual: boolean
  locale?: EmailLocale
  brandName?: string
}

const copy = {
  en: {
    subject: (name: string) => `Your refund for ${name}`,
    heading: 'Your payment has been refunded',
    intro: (name: string) => `We have refunded your payment for ${name}. Nothing else is needed from you.`,
    provider:
      'It goes back the way it came, through MercadoPago, and the time it takes to appear is your bank’s rather than ours — usually a few business days.',
    manual:
      'This one was not taken through a card, so the money goes back the way it arrived. If you have not seen it in a few days, reply to this email.',
    access: 'The download that came with the payment is closed along with it.',
    labels: {
      number: 'Receipt',
      application: 'Application',
      amount: 'Refunded',
      reason: 'Reason',
      date: 'Date',
      reference: 'Reference',
    },
    reasons: {
      withdrawal: 'Right of withdrawal',
      duplicate: 'Duplicate payment',
      not_delivered: 'Not delivered',
      goodwill: 'At our discretion',
      fraud: 'Payment disputed',
      other: 'Refunded on request',
    },
  },
  es: {
    subject: (name: string) => `Tu reembolso de ${name}`,
    heading: 'Devolvimos tu pago',
    intro: (name: string) => `Reembolsamos tu pago de ${name}. No necesitas hacer nada más.`,
    provider:
      'Vuelve por donde llegó, a través de MercadoPago, y el tiempo que tarde en aparecer depende de tu banco más que de nosotros: normalmente unos días hábiles.',
    manual:
      'Este pago no se tomó con tarjeta, así que el dinero vuelve por donde llegó. Si en unos días no lo ves, responde este correo.',
    access: 'La descarga que venía con el pago queda cerrada junto con él.',
    labels: {
      number: 'Comprobante',
      application: 'Aplicación',
      amount: 'Reembolsado',
      reason: 'Motivo',
      date: 'Fecha',
      reference: 'Referencia',
    },
    reasons: {
      withdrawal: 'Derecho a retracto',
      duplicate: 'Pago duplicado',
      not_delivered: 'No entregado',
      goodwill: 'Por nuestra decisión',
      fraud: 'Pago desconocido',
      other: 'Reembolsado a pedido',
    },
  },
} as const

/**
 * The notice that a sale was given back.
 *
 * It is sent for a refund and not for a chargeback, and that distinction is the whole reason this
 * template exists separately from a status email: a refund is us giving the money back and there is
 * something reassuring to say about it, whereas a chargeback is the payer's bank having already
 * taken it — they know, and writing to tell them reads as a challenge.
 *
 * The reason is named rather than left implicit because "derecho a retracto" is a statutory right
 * with a deadline, and a receipt that records which right was exercised is what makes the trail
 * readable a year later.
 */
const SaleRefundEmail = ({
  voucherNumber,
  applicationName,
  amount,
  currency,
  reason,
  refundedAt,
  reference,
  manual,
  locale = 'en',
  brandName,
}: SaleRefundEmailProps) => {
  const t = copy[locale]

  return (
    <EmailLayout preview={t.heading} heading={t.heading} brandName={brandName}>
      <Paragraph>{t.intro(applicationName)}</Paragraph>

      <DetailRows
        rows={[
          ...(voucherNumber ? [{ label: t.labels.number, value: voucherNumber, mono: true }] : []),
          { label: t.labels.application, value: applicationName },
          { label: t.labels.amount, value: formatMoney(amount, currency, locale) },
          { label: t.labels.reason, value: t.reasons[reason] },
          { label: t.labels.date, value: refundedAt },
          { label: t.labels.reference, value: reference, mono: true },
        ]}
      />

      <Paragraph tone="muted">{manual ? t.manual : t.provider}</Paragraph>
      <Paragraph tone="muted">{t.access}</Paragraph>
    </EmailLayout>
  )
}

SaleRefundEmail.PreviewProps = {
  voucherNumber: 'FS-2026-000042',
  applicationName: 'OpenBattery',
  amount: 4990,
  currency: 'CLP',
  reason: 'withdrawal',
  refundedAt: '19 September 2026',
  reference: '7f3c1a9e-2d51-4c1a-9a12-6b0f0d9a1c77',
  manual: false,
  locale: 'en',
} satisfies SaleRefundEmailProps

const renderSaleRefundEmail = (props: SaleRefundEmailProps): Promise<RenderedEmail> =>
  renderEmail(copy[props.locale ?? 'en'].subject(props.applicationName), <SaleRefundEmail {...props} />)

export { renderSaleRefundEmail, SaleRefundEmail }
export type { RefundReason, SaleRefundEmailProps }
export default SaleRefundEmail
