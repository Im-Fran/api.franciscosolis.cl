import { renderInvitationEmail, renderMagicLinkEmail, type RenderedEmail } from '@franciscosolis/emails'
import type { Env } from '@/env'

/**
 * The bodies live in `@franciscosolis/emails`, not here.
 *
 * They used to be template literals in this file, which meant hand-escaping every interpolated
 * value and hand-maintaining a plain-text twin of each HTML body. Both are now react-email's
 * problem: React escapes children, and the text alternative is derived from the rendered HTML, so
 * the two cannot drift. Rendering is asynchronous as a result — these functions return promises.
 */
type Template = RenderedEmail

/** Single-use sign-in link. `brandName` signs the footer with the address the mail goes out as. */
const magicLinkTemplate = (input: {
  url: string
  applicationName: string
  expiresInMinutes: number
  brandName?: string
}): Promise<Template> => renderMagicLinkEmail(input)

/** Invitation to an address an admin has just allowed in. */
const invitationTemplate = (input: {
  url: string
  applicationName: string
  invitedByName: string | null
  expiresInDays: number
  brandName?: string
}): Promise<Template> => renderInvitationEmail(input)

/**
 * Hands a message to Cloudflare Email Sending. The sender identity is fixed by `MAIL_FROM_NAME` /
 * `MAIL_FROM_EMAIL` and is also pinned in wrangler.jsonc via `allowed_sender_addresses`, so a bug
 * elsewhere cannot make the Worker send as some other address.
 */
const sendEmail = async (env: Env, to: string, template: Template) => {
  const result = await env.EMAIL.send({
    from: { email: env.MAIL_FROM_EMAIL, name: env.MAIL_FROM_NAME },
    to: [to],
    subject: template.subject,
    html: template.html,
    text: template.text,
  })
  return result.messageId
}

export { invitationTemplate, magicLinkTemplate, sendEmail }
export type { Template }
