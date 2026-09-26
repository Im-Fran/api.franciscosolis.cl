/** @jsxImportSource react */
import { ActionLink } from '../components/action-link'
import { EmailLayout } from '../components/email-layout'
import { Paragraph } from '../components/paragraph'
import type { EmailLocale } from '../locale'
import { renderEmail, type RenderedEmail } from '../render'

type MagicLinkEmailProps = {
  /** The single-use sign-in URL. */
  url: string
  /** Client application the sign-in was started from, shown so the recipient can place the email. */
  applicationName: string
  expiresInMinutes: number
  /** The language the sign-in was started in, or the account's own. English when neither is known. */
  locale?: EmailLocale
  brandName?: string
}

const copy = {
  en: {
    subject: (app: string) => `Your sign-in link for ${app}`,
    heading: (app: string) => `Sign in to ${app}`,
    body: (minutes: number) =>
      `Use the button below to finish signing in. The link works once and expires in ${minutes} minutes.`,
    action: 'Sign in',
    ignore: 'If you did not request this link, you can ignore this email — nobody can sign in without it.',
  },
  es: {
    subject: (app: string) => `Tu enlace para iniciar sesión en ${app}`,
    heading: (app: string) => `Inicia sesión en ${app}`,
    body: (minutes: number) =>
      `Usa el botón de abajo para terminar de iniciar sesión. El enlace funciona una sola vez y vence en ${minutes} minutos.`,
    action: 'Iniciar sesión',
    ignore: 'Si no pediste este enlace, puedes ignorar este correo — nadie puede iniciar sesión sin él.',
  },
} as const

/** Sign-in link sent by `apps/auth`'s magic link provider. */
const MagicLinkEmail = ({ url, applicationName, expiresInMinutes, locale = 'en', brandName }: MagicLinkEmailProps) => {
  const t = copy[locale]
  return (
    <EmailLayout preview={t.subject(applicationName)} heading={t.heading(applicationName)} brandName={brandName}>
      <Paragraph>{t.body(expiresInMinutes)}</Paragraph>
      <ActionLink href={url} label={t.action} />
      <Paragraph tone="muted">{t.ignore}</Paragraph>
    </EmailLayout>
  )
}

MagicLinkEmail.PreviewProps = {
  url: 'https://api.franciscosolis.cl/auth/magic-link/callback?token=preview-token',
  applicationName: 'Francisco Solis',
  expiresInMinutes: 15,
} satisfies MagicLinkEmailProps

const renderMagicLinkEmail = (props: MagicLinkEmailProps): Promise<RenderedEmail> =>
  renderEmail(copy[props.locale ?? 'en'].subject(props.applicationName), <MagicLinkEmail {...props} />)

export { MagicLinkEmail, renderMagicLinkEmail }
export type { MagicLinkEmailProps }
export default MagicLinkEmail
