/** @jsxImportSource react */
import { ActionLink } from '../components/action-link'
import { EmailLayout } from '../components/email-layout'
import { Paragraph } from '../components/paragraph'
import { renderEmail, type RenderedEmail } from '../render'

type InvitationEmailProps = {
  /** Where the recipient signs in to accept. Usually the client application's login page. */
  url: string
  applicationName: string
  /** Who invited them, when that is known. `null` keeps the sentence impersonal rather than blank. */
  invitedByName: string | null
  expiresInDays: number
  brandName?: string
}

/** Invitation sent by `apps/auth` when an admin adds an address to the allowed list. */
const InvitationEmail = ({ url, applicationName, invitedByName, expiresInDays, brandName }: InvitationEmailProps) => (
  <EmailLayout
    preview={`You have been invited to ${applicationName}`}
    heading={`You have been invited to ${applicationName}`}
    brandName={brandName}
  >
    <Paragraph>
      {invitedByName ? `${invitedByName} invited you to ${applicationName}.` : `You have been invited to ${applicationName}.`}
      {' '}
      Sign in with this email address to accept — the invitation expires in {expiresInDays} days.
    </Paragraph>
    <ActionLink href={url} label="Accept invitation" />
    <Paragraph tone="muted">
      The invitation is tied to this email address; signing in with a different one will not work.
    </Paragraph>
  </EmailLayout>
)

InvitationEmail.PreviewProps = {
  url: 'https://franciscosolis.cl/login',
  applicationName: 'Francisco Solis',
  invitedByName: 'Francisco Solis',
  expiresInDays: 7,
} satisfies InvitationEmailProps

const renderInvitationEmail = (props: InvitationEmailProps): Promise<RenderedEmail> =>
  renderEmail(`You have been invited to ${props.applicationName}`, <InvitationEmail {...props} />)

export { InvitationEmail, renderInvitationEmail }
export type { InvitationEmailProps }
export default InvitationEmail
