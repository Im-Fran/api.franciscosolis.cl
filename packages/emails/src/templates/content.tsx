/** @jsxImportSource react */
import { EmailLayout } from '../components/email-layout'
import { renderEmail, type RenderedEmail } from '../render'
import { theme } from '../theme'

type ContentEmailProps = {
  heading: string
  /**
   * Editor-authored HTML, inserted verbatim.
   *
   * This is not an escaping hole: reaching it requires an access token belonging to an
   * `@franciscosolis.cl` account, and an editor who can compose a message body already controls
   * the entire document. Escaping here would break the one thing they use it for — links.
   */
  html: string
  /** Inbox snippet. Falls back to the heading when the caller has nothing better. */
  preview?: string
  brandName?: string
}

/**
 * The wrapper `apps/cms` puts around an editorial message, so an ad-hoc send and a transactional
 * sign-in link arrive looking like they came from the same place.
 *
 * The body is dropped in as-is rather than parsed: the CMS's stored templates are HTML fragments
 * written by hand, and re-serialising them would silently rewrite whatever the editor tuned.
 */
const ContentEmail = ({ heading, html, preview, brandName }: ContentEmailProps) => (
  <EmailLayout preview={preview ?? heading} heading={heading} brandName={brandName}>
    <div
      style={{ fontSize: '16px', lineHeight: 1.65, color: theme.colors.body }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  </EmailLayout>
)

ContentEmail.PreviewProps = {
  heading: 'A new project is live',
  html: '<p>There is a new entry on the site. <a href="https://franciscosolis.cl">Take a look</a>.</p>',
} satisfies ContentEmailProps

const renderContentEmail = (
  { subject, ...props }: ContentEmailProps & { subject: string },
): Promise<RenderedEmail> => renderEmail(subject, <ContentEmail {...props} />)

export { ContentEmail, renderContentEmail }
export type { ContentEmailProps }
export default ContentEmail
