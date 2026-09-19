/** @jsxImportSource react */
import { ActionLink } from '../components/action-link'
import { DetailRows } from '../components/detail-rows'
import { EmailLayout } from '../components/email-layout'
import { Paragraph } from '../components/paragraph'
import type { EmailLocale } from '../locale'
import { formatMoney } from '../money'
import { renderEmail, type RenderedEmail } from '../render'

/** How the money reached us, as `apps/pages` records it on the sale. */
type SaleSource = 'mercadopago' | 'cash' | 'bank_transfer' | 'gift' | 'other'

type SaleReceiptEmailProps = {
  /** Voucher number, e.g. `FS-2026-000042`. The one thing a recipient quotes back at us. */
  voucherNumber: string
  /** Application the sale was for, by name rather than by slug. */
  applicationName: string
  /** `purchase` for a licence, `donation` for an optional payment. Changes the wording, not the shape. */
  kind: 'purchase' | 'donation'
  amount: number
  currency: string
  source: SaleSource
  /** When the sale was settled, already formatted by the sender — this template does no date work. */
  issuedAt: string
  /** Our own reference for the payment. What support looks a sale up by. */
  reference: string
  /** Where the buyer goes to download or to see what they bought. */
  url?: string
  /** Editor's note on a manual sale, when there is one. Free text; escaped as a child. */
  note?: string | null
  locale?: EmailLocale
  brandName?: string
}

const copy = {
  en: {
    subject: (number: string) => `Your receipt ${number}`,
    heading: { purchase: 'Thanks for your purchase', donation: 'Thanks for your support' },
    intro: {
      purchase: (name: string) => `This is your receipt for ${name}. Keep it — it is what a support conversation about this payment starts from.`,
      donation: (name: string) => `This is your receipt for the payment you made towards ${name}. Thank you — it is what keeps it being worked on.`,
    },
    action: { purchase: 'Go to your download', donation: 'Open the page' },
    labels: {
      number: 'Receipt',
      application: 'Application',
      amount: 'Amount',
      source: 'Paid with',
      date: 'Date',
      reference: 'Reference',
      note: 'Note',
    },
    sources: {
      mercadopago: 'MercadoPago',
      cash: 'Cash',
      bank_transfer: 'Bank transfer',
      gift: 'Gift — nothing was charged',
      other: 'Recorded manually',
    },
    gift: 'Nothing was charged for this one: it was given to you, and it entitles you to the downloads exactly as a paid one does.',
    withdrawal:
      'Under Chilean consumer law you may withdraw from this purchase within 10 days of this receipt. Reply to this email and we will refund it.',
  },
  es: {
    subject: (number: string) => `Tu comprobante ${number}`,
    heading: { purchase: 'Gracias por tu compra', donation: 'Gracias por tu aporte' },
    intro: {
      purchase: (name: string) => `Este es tu comprobante de ${name}. Guárdalo: es con lo que empieza cualquier conversación de soporte sobre este pago.`,
      donation: (name: string) => `Este es el comprobante del aporte que hiciste a ${name}. Gracias: es lo que permite seguir trabajando en él.`,
    },
    action: { purchase: 'Ir a tu descarga', donation: 'Abrir la página' },
    labels: {
      number: 'Comprobante',
      application: 'Aplicación',
      amount: 'Monto',
      source: 'Pagado con',
      date: 'Fecha',
      reference: 'Referencia',
      note: 'Nota',
    },
    sources: {
      mercadopago: 'MercadoPago',
      cash: 'Efectivo',
      bank_transfer: 'Transferencia bancaria',
      gift: 'Regalo — no se cobró nada',
      other: 'Registrado manualmente',
    },
    gift: 'Por este no se cobró nada: te fue regalado, y te habilita las descargas igual que uno pagado.',
    withdrawal:
      'Según la ley del consumidor chilena puedes retractarte de esta compra dentro de 10 días desde este comprobante. Responde este correo y te devolvemos el dinero.',
  },
} as const

/**
 * The voucher: what somebody gets when a sale is settled, and what is re-sent when they lose it.
 *
 * It is one email for every way money can arrive — MercadoPago, cash, a transfer, or a gift with no
 * money at all — because a receipt that looked different depending on how it was paid would be a
 * receipt somebody doubts. The source is a line in the detail block instead.
 *
 * The right-of-withdrawal line is only shown for a `purchase`: a donation is not a sale under the
 * Chilean consumer statute, and a gift has nothing to give back. It states the statutory 10 days
 * rather than a date, because this template does no date arithmetic — `apps/pages` owns the deadline
 * (`src/lib/sales.ts`) and shows it to the editor; the recipient needs to know the right exists.
 */
const SaleReceiptEmail = ({
  voucherNumber,
  applicationName,
  kind,
  amount,
  currency,
  source,
  issuedAt,
  reference,
  url,
  note,
  locale = 'en',
  brandName,
}: SaleReceiptEmailProps) => {
  const t = copy[locale]
  const heading = t.heading[kind]

  return (
    <EmailLayout preview={t.subject(voucherNumber)} heading={heading} brandName={brandName}>
      <Paragraph>{t.intro[kind](applicationName)}</Paragraph>

      <DetailRows
        rows={[
          { label: t.labels.number, value: voucherNumber, mono: true },
          { label: t.labels.application, value: applicationName },
          { label: t.labels.amount, value: formatMoney(amount, currency, locale) },
          { label: t.labels.source, value: t.sources[source] },
          { label: t.labels.date, value: issuedAt },
          { label: t.labels.reference, value: reference, mono: true },
          ...(note ? [{ label: t.labels.note, value: note }] : []),
        ]}
      />

      {source === 'gift' ? <Paragraph tone="muted">{t.gift}</Paragraph> : null}
      {url ? <ActionLink href={url} label={t.action[kind]} /> : null}
      {kind === 'purchase' && source !== 'gift' ? <Paragraph tone="muted">{t.withdrawal}</Paragraph> : null}
    </EmailLayout>
  )
}

SaleReceiptEmail.PreviewProps = {
  voucherNumber: 'FS-2026-000042',
  applicationName: 'OpenBattery',
  kind: 'purchase',
  amount: 4990,
  currency: 'CLP',
  source: 'mercadopago',
  issuedAt: '19 September 2026',
  reference: '7f3c1a9e-2d51-4c1a-9a12-6b0f0d9a1c77',
  url: 'https://franciscosolis.cl/application/openbattery',
  locale: 'en',
} satisfies SaleReceiptEmailProps

const renderSaleReceiptEmail = (props: SaleReceiptEmailProps): Promise<RenderedEmail> =>
  renderEmail(copy[props.locale ?? 'en'].subject(props.voucherNumber), <SaleReceiptEmail {...props} />)

export { renderSaleReceiptEmail, SaleReceiptEmail }
export type { SaleReceiptEmailProps, SaleSource }
export default SaleReceiptEmail
