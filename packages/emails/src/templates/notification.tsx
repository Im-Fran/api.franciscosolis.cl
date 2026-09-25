/** @jsxImportSource react */
import { Link } from 'react-email'
import { ActionLink } from '../components/action-link'
import { EmailLayout } from '../components/email-layout'
import { Paragraph } from '../components/paragraph'
import type { EmailLocale } from '../locale'
import { renderEmail, type RenderedEmail } from '../render'
import { theme } from '../theme'

type NotificationEmailProps = {
  /** Already rendered by `apps/notifications` in the recipient's language. Plain text. */
  title: string
  body: string
  /** Absolute URL of what the notification is about, or null when it is about nothing to open. */
  url: string | null
  /** Where the recipient changes how often they hear from us. Always present: it is the point. */
  preferencesUrl: string
  locale?: EmailLocale
  brandName?: string
}

const copy = {
  en: {
    action: 'Open',
    preferences: 'You are receiving this because your email notifications are set to immediate.',
    manage: 'Change how often we email you',
  },
  es: {
    action: 'Abrir',
    preferences: 'Recibes este correo porque tus notificaciones por correo están configuradas como inmediatas.',
    manage: 'Cambiar cada cuánto te escribimos',
  },
} as const

/**
 * One notification, sent the moment it happened, for somebody who chose `immediate`.
 *
 * Generic on purpose: the title and body come from `apps/notifications`' catalog, which is the one
 * place the wording of a notification lives, so a new kind of notification needs no new template.
 * Every string here is a React child and therefore escaped — some of them are an avatar rejection
 * reason or a product name somebody typed.
 */
const NotificationEmail = ({ title, body, url, preferencesUrl, locale = 'en', brandName }: NotificationEmailProps) => {
  const t = copy[locale]
  return (
    <EmailLayout preview={body} heading={title} brandName={brandName}>
      <Paragraph>{body}</Paragraph>
      {url ? <ActionLink href={url} label={t.action} /> : null}
      <Paragraph tone="muted">
        {t.preferences} <Link href={preferencesUrl} style={{ color: theme.colors.link, textDecorationLine: 'underline' }}>
          {t.manage}
        </Link>.
      </Paragraph>
    </EmailLayout>
  )
}

NotificationEmail.PreviewProps = {
  title: 'Your review of Simple Backups got a reply',
  body: 'The author answered what you wrote.',
  url: 'https://franciscosolis.cl/product/simple-backups',
  preferencesUrl: 'https://franciscosolis.cl/account/notifications',
  locale: 'en',
} satisfies NotificationEmailProps

const renderNotificationEmail = (props: NotificationEmailProps): Promise<RenderedEmail> =>
  renderEmail(props.title, <NotificationEmail {...props} />)

export { NotificationEmail, renderNotificationEmail }
export type { NotificationEmailProps }
export default NotificationEmail
