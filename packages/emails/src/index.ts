/**
 * Every email this monorepo sends is built here.
 *
 * A Worker imports a `render*Email` function, gets back `{ subject, html, text }` and hands that
 * to its Cloudflare Email Sending binding. It never assembles markup itself — that is the whole
 * point of the package: the templates live in one place, look the same, and are previewable
 * (`pnpm --filter @franciscosolis/emails run preview`) without deploying anything.
 *
 * The package ships TypeScript source, not a build. Wrangler already bundles each Worker with
 * esbuild, so a build step here would only add a stale artifact to keep in sync.
 */
export { ActionLink } from './components/action-link'
export type { ActionLinkProps } from './components/action-link'
export { EmailLayout } from './components/email-layout'
export type { EmailLayoutProps } from './components/email-layout'
export { Paragraph } from './components/paragraph'
export type { ParagraphProps } from './components/paragraph'
export { renderEmail } from './render'
export type { RenderedEmail } from './render'
export { ContentEmail, renderContentEmail } from './templates/content'
export type { ContentEmailProps } from './templates/content'
export { InvitationEmail, renderInvitationEmail } from './templates/invitation'
export type { InvitationEmailProps } from './templates/invitation'
export { MagicLinkEmail, renderMagicLinkEmail } from './templates/magic-link'
export type { MagicLinkEmailProps } from './templates/magic-link'
export { theme } from './theme'
