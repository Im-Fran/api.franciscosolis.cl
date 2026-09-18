/** @jsxImportSource react */
import { Section, Text } from 'react-email'
import { EmailLayout } from '../components/email-layout'
import { Paragraph } from '../components/paragraph'
import { renderEmail, type RenderedEmail } from '../render'
import { theme } from '../theme'

/**
 * Which of the two things happened.
 *
 * `sign_in` is somebody authenticating — a magic link opened, a Google sign-in completed.
 * `authorization` is an application being let in from a browser session that already existed, i.e.
 * the "Authorize" button rather than a fresh sign-in. They are worth telling apart: the second one
 * needs no credential at all, so a recipient who does not recognise it has a different problem.
 */
type AccountAccessEvent = 'sign_in' | 'authorization'

type AccountAccessEmailProps = {
  event: AccountAccessEvent
  /** Client application that was signed in to, or authorized. */
  applicationName: string
  /** Display name of the provider that proved who the user was ("Magic Link", "Google"). */
  providerName: string
  /** Already formatted for a reader. The sending Worker owns the formatting, not this template. */
  occurredAt: string
  /** Browser and platform, as far as they could be told from the user agent. */
  device: string | null
  /** City and country, as far as the edge could place the request. */
  location: string | null
  ipAddress: string | null
  brandName?: string
}

/** What a detail reads as when the request did not carry enough to fill it in. */
const UNKNOWN = 'Unknown'

/**
 * Subject and heading, which are deliberately the same string: this is a notification whose whole
 * content is its first line, and an inbox list is where most recipients will decide it is fine.
 */
const accountAccessSubject = ({ event, applicationName }: Pick<AccountAccessEmailProps, 'event' | 'applicationName'>) =>
  event === 'sign_in' ? `New sign-in to ${applicationName}` : `${applicationName} was authorized on your account`

/**
 * One labelled fact.
 *
 * A row of `<Text>` rather than a table cell on purpose: the plain-text alternative is derived from
 * this markup, and html-to-text renders a table as bare cells with the labels stranded, which is
 * precisely the part a recipient skimming for "where was this" needs.
 */
const Detail = ({ label, value }: { label: string; value: string | null }) => (
  <Text style={{ margin: '0 0 6px', fontSize: '14px', lineHeight: '1.6', color: theme.colors.body }}>
    <span style={{ color: theme.colors.muted }}>{label}: </span>
    {value || UNKNOWN}
  </Text>
)

/**
 * Sent by `apps/auth` whenever an application gains access to an account, however it gained it.
 *
 * Every detail is rendered even when it is unknown. A blank row is a fact — "the edge could not
 * place this request" is something a recipient judging whether it was them should see, rather than
 * a line quietly missing from a list they have no reason to know the length of.
 */
const AccountAccessEmail = ({
  event,
  applicationName,
  providerName,
  occurredAt,
  device,
  location,
  ipAddress,
  brandName,
}: AccountAccessEmailProps) => (
  <EmailLayout
    preview={
      event === 'sign_in'
        ? `Signed in to ${applicationName} — ${location || occurredAt}`
        : `${applicationName} was authorized — ${location || occurredAt}`
    }
    heading={accountAccessSubject({ event, applicationName })}
    brandName={brandName}
  >
    <Paragraph>
      {event === 'sign_in'
        ? `Your account was just used to sign in to ${applicationName}.`
        : `${applicationName} was just authorized to use your account, from a browser that was already signed in.`}
    </Paragraph>
    <Section
      bgcolor={theme.colors.surfaceTinted}
      style={{
        backgroundColor: theme.colors.surfaceTinted,
        borderRadius: theme.radiusInner,
        padding: '16px 18px',
        margin: '0 0 24px',
      }}
    >
      <Detail label="When" value={occurredAt} />
      <Detail label="Application" value={applicationName} />
      <Detail label="Signed in with" value={providerName} />
      <Detail label="Device" value={device} />
      <Detail label="Location" value={location} />
      <Detail label="IP address" value={ipAddress} />
    </Section>
    <Paragraph tone="muted">
      If this was you, there is nothing to do. If it was not, sign in and close every session you do
      not recognise — that ends this access straight away — and review the applications your account
      is signed in to.
    </Paragraph>
  </EmailLayout>
)

AccountAccessEmail.PreviewProps = {
  event: 'sign_in',
  applicationName: 'Francisco Solis',
  providerName: 'Magic Link',
  occurredAt: '17 Sep 2026, 14:32 UTC',
  device: 'Chrome on macOS',
  location: 'Santiago, Chile',
  ipAddress: '203.0.113.24',
} satisfies AccountAccessEmailProps

const renderAccountAccessEmail = (props: AccountAccessEmailProps): Promise<RenderedEmail> =>
  renderEmail(accountAccessSubject(props), <AccountAccessEmail {...props} />)

export { AccountAccessEmail, accountAccessSubject, renderAccountAccessEmail }
export type { AccountAccessEmailProps, AccountAccessEvent }
export default AccountAccessEmail
