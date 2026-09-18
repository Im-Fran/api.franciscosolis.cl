/** @jsxImportSource react */
import { ActionLink } from '../components/action-link'
import { EmailLayout } from '../components/email-layout'
import { Paragraph } from '../components/paragraph'
import type { EmailLocale } from '../locale'
import { renderEmail, type RenderedEmail } from '../render'

type SupportTicketReceivedEmailProps = {
  /** Human-readable ticket reference, e.g. `FS-1042`. */
  reference: string
  /** The subject as it was filed, which is not necessarily what they typed — it may have been triaged. */
  subject: string
  /** The ticket URL, secret and all. Built by `apps/support`; never assembled here. */
  url: string
  /** Address a reply to this message reaches the ticket through. */
  replyTo: string
  locale?: EmailLocale
  brandName?: string
}

const copy = {
  en: {
    subject: (reference: string, subject: string) => `[${reference}] ${subject}`,
    heading: 'We have your request',
    intro: (reference: string) =>
      `Thanks for writing in. Your request is open as ${reference}, and somebody from the team will pick it up.`,
    action: 'View your ticket',
    reply: (address: string) =>
      `You can also just reply to this email — anything you send to ${address} lands on the ticket.`,
    keep: 'Keep this email: the link above is how you get back to the conversation without an account.',
  },
  es: {
    subject: (reference: string, subject: string) => `[${reference}] ${subject}`,
    heading: 'Recibimos tu solicitud',
    intro: (reference: string) =>
      `Gracias por escribirnos. Tu solicitud quedó abierta como ${reference} y alguien del equipo la va a tomar.`,
    action: 'Ver tu ticket',
    reply: (address: string) =>
      `También puedes responder este correo: todo lo que envíes a ${address} queda en el ticket.`,
    keep: 'Guarda este correo: el enlace de arriba es como vuelves a la conversación sin tener una cuenta.',
  },
} as const

/**
 * The confirmation sent the moment a ticket is opened.
 *
 * It carries the only copy of the access link that ever leaves the system — the secret behind it is
 * stored as a hash and cannot be recovered — which is why the last line tells the recipient to keep
 * the email rather than assuming they will.
 */
const SupportTicketReceivedEmail = ({
  reference,
  subject,
  url,
  replyTo,
  locale = 'en',
  brandName,
}: SupportTicketReceivedEmailProps) => {
  const t = copy[locale]
  return (
    <EmailLayout preview={t.heading} heading={t.heading} brandName={brandName}>
      <Paragraph>{t.intro(reference)}</Paragraph>
      {/* The subject is echoed as a React child, so it is escaped. It is whatever somebody typed. */}
      <Paragraph tone="muted">{subject}</Paragraph>
      <ActionLink href={url} label={t.action} />
      <Paragraph tone="muted">{t.reply(replyTo)}</Paragraph>
      <Paragraph tone="muted">{t.keep}</Paragraph>
    </EmailLayout>
  )
}

SupportTicketReceivedEmail.PreviewProps = {
  reference: 'FS-1042',
  subject: 'The sign-in link never arrives',
  url: 'https://franciscosolis.cl/tickets/FS-1042#k=preview-secret',
  replyTo: 'soporte@franciscosolis.cl',
  locale: 'en',
} satisfies SupportTicketReceivedEmailProps

const renderSupportTicketReceivedEmail = (props: SupportTicketReceivedEmailProps): Promise<RenderedEmail> =>
  renderEmail(
    copy[props.locale ?? 'en'].subject(props.reference, props.subject),
    <SupportTicketReceivedEmail {...props} />,
  )

export { renderSupportTicketReceivedEmail, SupportTicketReceivedEmail }
export type { SupportTicketReceivedEmailProps }
export default SupportTicketReceivedEmail
