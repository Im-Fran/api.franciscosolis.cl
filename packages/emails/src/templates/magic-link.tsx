/** @jsxImportSource react */
import { ActionLink } from '../components/action-link'
import { EmailLayout } from '../components/email-layout'
import { Paragraph } from '../components/paragraph'
import { renderEmail, type RenderedEmail } from '../render'

type MagicLinkEmailProps = {
  /** The single-use sign-in URL. */
  url: string
  /** Client application the sign-in was started from, shown so the recipient can place the email. */
  applicationName: string
  expiresInMinutes: number
  brandName?: string
}

/** Sign-in link sent by `apps/auth`'s magic link provider. */
const MagicLinkEmail = ({ url, applicationName, expiresInMinutes, brandName }: MagicLinkEmailProps) => (
  <EmailLayout
    preview={`Your sign-in link for ${applicationName}`}
    heading={`Sign in to ${applicationName}`}
    brandName={brandName}
  >
    <Paragraph>
      Use the button below to finish signing in. The link works once and expires in {expiresInMinutes} minutes.
    </Paragraph>
    <ActionLink href={url} label="Sign in" />
    <Paragraph tone="muted">
      If you did not request this link, you can ignore this email — nobody can sign in without it.
    </Paragraph>
  </EmailLayout>
)

MagicLinkEmail.PreviewProps = {
  url: 'https://api.franciscosolis.cl/auth/magic-link/callback?token=preview-token',
  applicationName: 'Francisco Solis',
  expiresInMinutes: 15,
} satisfies MagicLinkEmailProps

const renderMagicLinkEmail = (props: MagicLinkEmailProps): Promise<RenderedEmail> =>
  renderEmail(`Your sign-in link for ${props.applicationName}`, <MagicLinkEmail {...props} />)

export { MagicLinkEmail, renderMagicLinkEmail }
export type { MagicLinkEmailProps }
export default MagicLinkEmail
