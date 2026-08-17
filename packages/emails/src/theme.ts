/**
 * Design tokens shared by every email this monorepo sends.
 *
 * They exist as plain values rather than a stylesheet because email clients strip `<style>` blocks
 * and none of them support CSS custom properties: everything has to end up as an inline `style`
 * attribute on the element itself. Keeping the values here is what stops each template from
 * inventing its own slightly different indigo.
 */
const theme = {
  colors: {
    /** Page background, outside the card. */
    background: '#0b0b0f',
    /** The card the message sits in. */
    surface: '#15151c',
    border: '#26262f',
    heading: '#f4f4f5',
    body: '#a1a1aa',
    muted: '#71717a',
    accent: '#6366f1',
    accentText: '#ffffff',
    link: '#818cf8',
  },
  /**
   * System font stack. No web fonts: `@font-face` is ignored by Outlook and Gmail's web client,
   * and a remote font is one more asset a client can block.
   */
  fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif",
  /** Keeps the column narrow enough to stay readable on a phone without any media query. */
  maxWidth: '520px',
  radius: '12px',
} as const

export { theme }
