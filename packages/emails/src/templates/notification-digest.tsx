/** @jsxImportSource react */
import { Link, Section, Text } from 'react-email'
import { ActionLink } from '../components/action-link'
import { EmailLayout } from '../components/email-layout'
import { Paragraph } from '../components/paragraph'
import type { EmailLocale } from '../locale'
import { renderEmail, type RenderedEmail } from '../render'
import { theme } from '../theme'

type DigestItem = {
  title: string
  body: string
  /** Absolute URL, or null. */
  url: string | null
  /** Already formatted for the reader, in their language and the digest's time zone. */
  when: string
}

type DigestPeriod = 'daily' | 'weekly'

type NotificationDigestEmailProps = {
  period: DigestPeriod
  items: DigestItem[]
  /** Notifications in the period beyond `items`, summarised as a count rather than listed. */
  moreCount: number
  /** The website inbox. */
  inboxUrl: string
  preferencesUrl: string
  locale?: EmailLocale
  brandName?: string
}

const copy = {
  en: {
    subject: (period: DigestPeriod, count: number) =>
      `${period === 'daily' ? 'Your daily summary' : 'Your weekly summary'}: ${count} ${count === 1 ? 'notification' : 'notifications'}`,
    heading: (period: DigestPeriod) => (period === 'daily' ? 'Your daily summary' : 'Your weekly summary'),
    intro: (period: DigestPeriod) =>
      period === 'daily'
        ? 'Here is what happened on your account since yesterday that you have not seen yet.'
        : 'Here is what happened on your account this week that you have not seen yet.',
    more: (count: number) => `…and ${count} more.`,
    action: 'Open your notifications',
    open: 'Open',
    preferences: (period: DigestPeriod) =>
      `You receive a ${period === 'daily' ? 'daily' : 'weekly'} summary instead of one email per notification.`,
    manage: 'Change how often we email you',
  },
  es: {
    subject: (period: DigestPeriod, count: number) =>
      `${period === 'daily' ? 'Tu resumen diario' : 'Tu resumen semanal'}: ${count} ${count === 1 ? 'notificación' : 'notificaciones'}`,
    heading: (period: DigestPeriod) => (period === 'daily' ? 'Tu resumen diario' : 'Tu resumen semanal'),
    intro: (period: DigestPeriod) =>
      period === 'daily'
        ? 'Esto es lo que pasó en tu cuenta desde ayer y que todavía no has visto.'
        : 'Esto es lo que pasó en tu cuenta esta semana y que todavía no has visto.',
    more: (count: number) => `…y ${count} más.`,
    action: 'Abrir tus notificaciones',
    open: 'Abrir',
    preferences: (period: DigestPeriod) =>
      `Recibes un resumen ${period === 'daily' ? 'diario' : 'semanal'} en lugar de un correo por cada notificación.`,
    manage: 'Cambiar cada cuánto te escribimos',
  },
} as const

/**
 * One listed notification.
 *
 * Rows of `<Text>` rather than a table, for the reason `account-access.tsx` gives: the plain-text
 * part is derived from this markup, and html-to-text flattens a table into cells whose labels end
 * up stranded from their values.
 */
const Item = ({ item, openLabel }: { item: DigestItem; openLabel: string }) => (
  <Section
    style={{
      borderBottom: `1px solid ${theme.colors.border}`,
      padding: '0 0 14px',
      margin: '0 0 14px',
    }}
  >
    <Text style={{ margin: '0 0 2px', fontSize: '12px', lineHeight: '1.5', color: theme.colors.muted }}>{item.when}</Text>
    <Text style={{ margin: '0 0 4px', fontSize: '15px', lineHeight: '1.5', fontWeight: 600, color: theme.colors.body }}>
      {item.title}
    </Text>
    <Text style={{ margin: 0, fontSize: '14px', lineHeight: '1.6', color: theme.colors.body }}>
      {item.body}
      {item.url ? (
        <>
          {' '}
          <Link href={item.url} style={{ color: theme.colors.link, textDecorationLine: 'underline' }}>
            {openLabel}
          </Link>
        </>
      ) : null}
    </Text>
  </Section>
)

/**
 * The daily or weekly summary `apps/notifications` sends instead of one email per notification —
 * the reason that Worker exists. It lists what the recipient has *not* already read on the site;
 * the Worker skips the send entirely when that is nothing, so an empty digest is never rendered.
 */
const NotificationDigestEmail = ({
  period,
  items,
  moreCount,
  inboxUrl,
  preferencesUrl,
  locale = 'en',
  brandName,
}: NotificationDigestEmailProps) => {
  const t = copy[locale]
  return (
    <EmailLayout preview={items[0]?.title ?? t.heading(period)} heading={t.heading(period)} brandName={brandName}>
      <Paragraph>{t.intro(period)}</Paragraph>
      {items.map((item, index) => (
        <Item key={index} item={item} openLabel={t.open} />
      ))}
      {moreCount > 0 ? <Paragraph tone="muted">{t.more(moreCount)}</Paragraph> : null}
      <ActionLink href={inboxUrl} label={t.action} />
      <Paragraph tone="muted">
        {t.preferences(period)} <Link href={preferencesUrl} style={{ color: theme.colors.link, textDecorationLine: 'underline' }}>
          {t.manage}
        </Link>.
      </Paragraph>
    </EmailLayout>
  )
}

NotificationDigestEmail.PreviewProps = {
  period: 'daily',
  items: [
    {
      title: 'New sign-in to Francisco Solis',
      body: 'Signed in with Magic Link from Chrome on macOS · Santiago, Chile. Not you? Close the session.',
      url: 'https://franciscosolis.cl/account/sessions',
      when: '22 Sept 2026, 18:04',
    },
    {
      title: 'Simple Backups 2.1.0 is out',
      body: 'A new stable release of something you own.',
      url: 'https://franciscosolis.cl/product/simple-backups',
      when: '22 Sept 2026, 21:40',
    },
  ],
  moreCount: 0,
  inboxUrl: 'https://franciscosolis.cl/account/notifications',
  preferencesUrl: 'https://franciscosolis.cl/account/notifications',
  locale: 'en',
} satisfies NotificationDigestEmailProps

const notificationDigestSubject = ({
  period,
  items,
  moreCount,
  locale = 'en',
}: Pick<NotificationDigestEmailProps, 'period' | 'items' | 'moreCount' | 'locale'>) =>
  copy[locale].subject(period, items.length + moreCount)

const renderNotificationDigestEmail = (props: NotificationDigestEmailProps): Promise<RenderedEmail> =>
  renderEmail(notificationDigestSubject(props), <NotificationDigestEmail {...props} />)

export { NotificationDigestEmail, notificationDigestSubject, renderNotificationDigestEmail }
export type { DigestItem, DigestPeriod, NotificationDigestEmailProps }
export default NotificationDigestEmail
