/**
 * Design tokens shared by every email this monorepo sends.
 *
 * They exist as plain values rather than a stylesheet because email clients strip `<style>` blocks
 * and none of them support CSS custom properties: everything has to end up as an inline `style`
 * attribute on the element itself. Keeping the values here is what stops each template from
 * inventing its own slightly different indigo.
 */

/**
 * The FranciscoSolis palette, verbatim from the brand guidelines.
 *
 * Nothing outside this object holds a hex code, and nothing inside it is invented: every entry is
 * either a published brand token or a blend of two of them, written out because email clients
 * cannot be trusted with `rgba()` over a background.
 */
const palette = {
  /** Gradient start — bottom-left. */
  periwinkle500: '#5a68c4',
  /** Gradient end — top-right. */
  plum500: '#8a4270',
  /** The accent: buttons, links, the "Francisco" half of the wordmark. */
  iris500: '#75549c',
  /** The accent on dark surfaces. `iris500` fails contrast there (2.8:1). */
  iris300: '#b298d6',
  /** Tinted light surface. */
  iris050: '#f4f1f9',
  ink: '#1e1e1e',
  paper: '#fafafa',
  white: '#ffffff',
  /** `iris500` at 18% over white — the hairline that separates a surface from the page. */
  iris018: '#e6e0ed',
  /** `iris500` at 10% over white — the same hairline, one step quieter, for dividers. */
  iris010: '#f0ebf5',
  /** `ink` at 70% over white. The one grey these emails use, and the floor for legible small print. */
  ink070: '#616161',
} as const

/**
 * Why this is a light theme, and why every surface names its colour twice.
 *
 * The palette used to be dark, which is the single worst thing an email can be. Outlook.com and
 * Gmail's web client both rewrite colours they consider to be part of a theme, and a dark card is
 * exactly what they target: the background gets forced back to white while the text keeps whatever
 * pale grey it was authored in, and the message arrives as light grey on white. A light-first
 * design has nothing for them to "fix", so it survives the rewrite untouched.
 *
 * The two `<meta>` tags in `EmailLayout` close the other half of the same hole — they are what stop
 * Apple Mail and iOS from auto-inverting a message that never asked to be inverted.
 *
 * Contrast, measured against the surface each colour actually sits on (WCAG 2.1):
 *
 * | Pairing                       | Ratio  | Level |
 * |-------------------------------|--------|-------|
 * | `heading` / `body` on surface | 17.4:1 | AAA   |
 * | `muted` on surface            |  6.1:1 | AA    |
 * | `muted` on `surfaceTinted`    |  5.5:1 | AA    |
 * | `link` on surface             |  5.9:1 | AA    |
 * | `link` on `surfaceTinted`     |  5.4:1 | AA    |
 * | `accentText` on `accent`      |  5.9:1 | AA    |
 *
 * The old palette's body copy was `#a1a1aa`, which is 2.4:1 the moment a client repaints the card
 * white. Nothing here drops below 5.3:1 on either surface it is allowed to appear on.
 */
const theme = {
  colors: {
    /** Page background, outside the card. The brand's tinted light surface. */
    background: palette.iris050,
    /** The card the message sits in. Deliberately pure white, not `paper` — it has to read as
     *  lifted off the tinted page, and 4 points of luminance does not do that. */
    surface: palette.white,
    /** Tinted panel inside the card: the copy-this-link block, callouts. */
    surfaceTinted: palette.iris050,
    border: palette.iris018,
    divider: palette.iris010,
    heading: palette.ink,
    body: palette.ink,
    muted: palette.ink070,
    accent: palette.iris500,
    accentText: palette.white,
    link: palette.iris500,
  },
  /**
   * Brand gradient, 45°, periwinkle (bottom-left) → plum (top-right). Never reversed, never
   * re-angled. Outlook's Word rendering engine ignores `background-image` outright, which is why
   * every element carrying this also carries `colors.accent` as a plain `background-color`.
   */
  gradient: `linear-gradient(45deg, ${palette.periwinkle500} 0%, ${palette.plum500} 100%)`,
  /**
   * The horizontal lockup, served by `apps/api` from `/brand/lockup.png`.
   *
   * It is a hosted PNG rather than the SVG source or a `data:` URI because Gmail strips inline SVG
   * and blocks `data:` images outright, and it has the white plate baked in rather than an alpha
   * channel because a client that repaints the card dark does not repaint image pixels — a
   * transparent lockup would put ink-coloured "Solis" on a dark surface and lose the word.
   *
   * `alt` carries the wordmark so a recipient with images off still gets the brand name. It does
   * not reach the plain-text alternative — `toPlainText` skips images, deliberately — which is why
   * the footer names the brand in words as well.
   */
  logo: {
    src: 'https://api.franciscosolis.cl/brand/lockup.png',
    alt: 'FranciscoSolis',
    /** Served at 2× (400×66) for retina; the brand floor for this lockup is 24 px tall. */
    width: 200,
    height: 33,
  },
  /**
   * System font stack. No web fonts: `@font-face` is ignored by Outlook and Gmail's web client,
   * and a remote font is one more asset a client can block. Sora is the wordmark face only, and it
   * arrives baked into the lockup PNG.
   */
  fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif",
  /** Keeps the column narrow enough to stay readable on a phone without any media query. */
  maxWidth: '520px',
  radius: '14px',
  /** Radius for the things inside the card — button, tinted panel. */
  radiusInner: '10px',
} as const

export { palette, theme }
