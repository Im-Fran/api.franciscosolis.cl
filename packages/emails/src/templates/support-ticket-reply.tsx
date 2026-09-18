/** @jsxImportSource react */
import { Hr, Text } from 'react-email'
import { ActionLink } from '../components/action-link'
import { EmailLayout } from '../components/email-layout'
import { Paragraph } from '../components/paragraph'
import type { EmailLocale } from '../locale'
import { renderEmail, type RenderedEmail } from '../render'
import { theme } from '../theme'

type SupportReplyExcerpt = {
  /** Who wrote it, as the recipient should see it — never an internal address. */
  author: string
  /** Trimmed and capped by the caller. Rendered as a React child, so it is escaped here. */
  body: string
}

type SupportTicketReplyEmailProps = {
  reference: string
  subject: string
  url: string
  replyTo: string
  /** Every agent reply since the last time this recipient was emailed, oldest first. */
  messages: SupportReplyExcerpt[]
  locale?: EmailLocale
  brandName?: string
}

const copy = {
  en: {
    subject: (reference: string, subject: string) => `[${reference}] ${subject}`,
    headingOne: 'There is a reply on your ticket',
    headingMany: (count: number) => `There are ${count} new replies on your ticket`,
    action: 'Open the conversation',
    reply: (address: string) => `Replying to this email adds your answer to the ticket. It reaches us at ${address}.`,
  },
  es: {
    subject: (reference: string, subject: string) => `[${reference}] ${subject}`,
    headingOne: 'Hay una respuesta en tu ticket',
    headingMany: (count: number) => `Hay ${count} respuestas nuevas en tu ticket`,
    action: 'Abrir la conversación',
    reply: (address: string) => `Si respondes este correo, tu respuesta se agrega al ticket. Nos llega a ${address}.`,
  },
} as const

/**
 * The deferred notice: what somebody gets when the support team answered and they did not come back
 * to read it within half an hour.
 *
 * It is a **digest**, not one email per reply. The rule that schedules it keeps a single pending
 * notice per person per ticket, so a burst of three replies becomes one message covering all three —
 * which is the whole reason the excerpt list is a prop rather than a single body.
 *
 * Every excerpt is rendered as a React child and never through `dangerouslySetInnerHTML`. That is
 * not a style preference: the text in here originated in a support thread, which is the most
 * thoroughly unauthenticated input this monorepo handles. `ContentEmail` exists for editorial HTML
 * and must never be pointed at any of this.
 */
const SupportTicketReplyEmail = ({
  reference,
  subject,
  url,
  replyTo,
  messages,
  locale = 'en',
  brandName,
}: SupportTicketReplyEmailProps) => {
  const t = copy[locale]
  const heading = messages.length > 1 ? t.headingMany(messages.length) : t.headingOne
  return (
    <EmailLayout preview={heading} heading={heading} brandName={brandName}>
      <Paragraph tone="muted">
        {reference} · {subject}
      </Paragraph>
      {messages.map((message, index) => (
        <div key={`${message.author}-${index}`}>
          {index > 0 ? <Hr style={{ borderColor: theme.colors.border, margin: '0 0 24px' }} /> : null}
          <Text
            style={{
              margin: '0 0 8px',
              fontSize: '13px',
              fontWeight: 600,
              lineHeight: '1.6',
              color: theme.colors.muted,
            }}
          >
            {message.author}
          </Text>
          {/* `whiteSpace: pre-wrap` because the source is plain text and its line breaks are meaning:
              a pasted error message collapsed into one paragraph is unreadable. */}
          <Text
            style={{
              margin: '0 0 24px',
              fontSize: '16px',
              lineHeight: '1.65',
              color: theme.colors.body,
              whiteSpace: 'pre-wrap',
            }}
          >
            {message.body}
          </Text>
        </div>
      ))}
      <ActionLink href={url} label={t.action} />
      <Paragraph tone="muted">{t.reply(replyTo)}</Paragraph>
    </EmailLayout>
  )
}

SupportTicketReplyEmail.PreviewProps = {
  reference: 'FS-1042',
  subject: 'The sign-in link never arrives',
  url: 'https://franciscosolis.cl/tickets/FS-1042#k=preview-secret',
  replyTo: 'soporte@franciscosolis.cl',
  messages: [
    { author: 'Support', body: 'Thanks for the detail — could you tell us which mail provider you use?' },
    { author: 'Support', body: 'We found the delivery in our logs; it looks like it was filed as spam.' },
  ],
  locale: 'en',
} satisfies SupportTicketReplyEmailProps

const renderSupportTicketReplyEmail = (props: SupportTicketReplyEmailProps): Promise<RenderedEmail> =>
  renderEmail(copy[props.locale ?? 'en'].subject(props.reference, props.subject), <SupportTicketReplyEmail {...props} />)

export { renderSupportTicketReplyEmail, SupportTicketReplyEmail }
export type { SupportReplyExcerpt, SupportTicketReplyEmailProps }
export default SupportTicketReplyEmail
