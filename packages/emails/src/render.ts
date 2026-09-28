import { render, toPlainText } from '@react-email/render'
import type { ReactElement } from 'react'

/**
 * Two adjustments to what html-to-text does on its own:
 *
 * - It shouts headings in upper case by default, which reads as an alarm in a sign-in email and is
 *   exactly the shape spam filters score against. The heading keeps its own casing.
 * - Purely visual elements — the gradient rule at the head of the card — are a non-breaking space
 *   in a table cell, and would otherwise open every message with a run of blank lines. `PLAIN_TEXT_SKIP_CLASS`
 *   is how a component opts out; it is a class rather than an inline marker because a class
 *   attribute is the one hook html-to-text can select on and mail clients ignore.
 */
const PLAIN_TEXT_SKIP_CLASS = 'skip-in-text'

const PLAIN_TEXT_SELECTORS = [
  { selector: 'h1', options: { uppercase: false } },
  { selector: 'h2', options: { uppercase: false } },
  { selector: `.${PLAIN_TEXT_SKIP_CLASS}`, format: 'skip' },
]

/** A message body ready to hand to Cloudflare Email Sending. */
type RenderedEmail = {
  subject: string
  html: string
  text: string
}

/**
 * Renders a react-email element to the `html` + `text` pair a message needs.
 *
 * Two things worth knowing:
 *
 * - The HTML is rendered once and the plain-text alternative is derived from it, rather than
 *   calling `render` twice with `plainText: true`. Same output, half the server-render work, and —
 *   more usefully — the two bodies cannot drift apart, because there is only one source.
 * - `pretty` is deliberately off. It is the option that drags Prettier into the bundle, and
 *   whitespace in a body nobody reads as source is worth nothing. Both Workers alias
 *   `prettier/standalone` away for exactly this reason (see their `wrangler.jsonc`).
 *
 * `@react-email/render` resolves to its `workerd` build here, which server-renders through
 * `react-dom/server.edge`. No Node-only API is involved.
 */
const renderEmail = async (subject: string, element: ReactElement): Promise<RenderedEmail> => {
  const html = await render(element, { pretty: false })
  return { subject, html, text: toPlainText(html, { selectors: PLAIN_TEXT_SELECTORS }) }
}

export { PLAIN_TEXT_SKIP_CLASS, renderEmail }
export type { RenderedEmail }
