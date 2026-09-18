/** @jsxImportSource react */
import { ActionLink } from '../components/action-link'
import { EmailLayout } from '../components/email-layout'
import { Paragraph } from '../components/paragraph'
import type { EmailLocale } from '../locale'
import { renderEmail, type RenderedEmail } from '../render'

type SupportParticipantAddedEmailProps = {
  reference: string
  subject: string
  url: string
  replyTo: string
  locale?: EmailLocale
  brandName?: string
}

const copy = {
  en: {
    subject: (reference: string) => `You were added to ${reference}`,
    heading: 'You were added to a support ticket',
    intro: (reference: string) =>
      `Somebody put you on ${reference} so you can follow it and answer if you need to.`,
    action: 'Read the conversation',
    reply: (address: string) => `Replying to this email adds your answer to the ticket, at ${address}.`,
  },
  es: {
    subject: (reference: string) => `Te agregaron a ${reference}`,
    heading: 'Te agregaron a un ticket de soporte',
    intro: (reference: string) =>
      `Alguien te sumó a ${reference} para que puedas seguirlo y responder si hace falta.`,
    action: 'Leer la conversación',
    reply: (address: string) => `Si respondes este correo, tu respuesta se agrega al ticket, en ${address}.`,
  },
} as const

/**
 * Sent when somebody is put on an existing ticket.
 *
 * It exists so that the deferred digest does not have to. Back-filling a new watcher into the next
 * digest would email a stranger a conversation they were not part of when it happened; this gives
 * them the link and lets them decide how much of it to read.
 */
const SupportParticipantAddedEmail = ({
  reference,
  subject,
  url,
  replyTo,
  locale = 'en',
  brandName,
}: SupportParticipantAddedEmailProps) => {
  const t = copy[locale]
  return (
    <EmailLayout preview={t.heading} heading={t.heading} brandName={brandName}>
      <Paragraph>{t.intro(reference)}</Paragraph>
      <Paragraph tone="muted">{subject}</Paragraph>
      <ActionLink href={url} label={t.action} />
      <Paragraph tone="muted">{t.reply(replyTo)}</Paragraph>
    </EmailLayout>
  )
}

SupportParticipantAddedEmail.PreviewProps = {
  reference: 'FS-1042',
  subject: 'The sign-in link never arrives',
  url: 'https://franciscosolis.cl/tickets/FS-1042#k=preview-secret',
  replyTo: 'soporte@franciscosolis.cl',
  locale: 'en',
} satisfies SupportParticipantAddedEmailProps

const renderSupportParticipantAddedEmail = (
  props: SupportParticipantAddedEmailProps,
): Promise<RenderedEmail> =>
  renderEmail(copy[props.locale ?? 'en'].subject(props.reference), <SupportParticipantAddedEmail {...props} />)

export { renderSupportParticipantAddedEmail, SupportParticipantAddedEmail }
export type { SupportParticipantAddedEmailProps }
export default SupportParticipantAddedEmail
