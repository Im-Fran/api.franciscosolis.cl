/** @jsxImportSource react */
import { Body, Container, Head, Heading, Hr, Html, Img, Link, Preview, Section, Text } from 'react-email'
import type { ReactNode } from 'react'
import { company } from '../company'
import { PLAIN_TEXT_SKIP_CLASS } from '../render'
import { theme } from '../theme'

type EmailLayoutProps = {
  /** Text shown in the inbox next to the subject. Never rendered in the body itself. */
  preview: string
  heading: string
  /** Name the footer signs off with. The apps pass their `MAIL_FROM_NAME`. */
  brandName?: string
  /** Overrides the hosted lockup. Only useful to a preview or a test that cannot reach the API. */
  logoSrc?: string
  children: ReactNode
}

/**
 * One line of the sender's identity block. Small print, but never smaller than `muted` on white
 * clears (6.1:1) — this is the part of the message a recipient reads when they are suspicious of
 * it, which is the worst possible moment for it to be unreadable.
 */
const IDENTITY_LINE = {
  margin: 0,
  fontSize: '12px',
  lineHeight: '1.6',
  color: theme.colors.muted,
} as const

/**
 * Footer links stay underlined: at 12 px, colour alone is not a reliable affordance, and a
 * recipient reading this block is looking for something to click. `textDecorationLine` rather than
 * the `textDecoration` shorthand, because react-email's `<Link>` already emits the former — the
 * shorthand would leave both in the attribute and rely on their order.
 */
const FOOTER_LINK = { color: theme.colors.link, textDecorationLine: 'underline' } as const

/**
 * The shell every template renders inside: one centred white card on the brand's tinted page,
 * under a 4 px gradient rule and the horizontal lockup.
 *
 * Four things here are load-bearing rather than decorative:
 *
 * - **The two `<meta>` tags.** `color-scheme` and `supported-color-schemes` are what tell Apple
 *   Mail, iOS Mail and Outlook for Mac that this message has already chosen its colours and must
 *   not be auto-inverted. Without them a light card gets algorithmically darkened, and the
 *   algorithm repaints backgrounds without repainting the lockup or the button label.
 * - **`bgcolor` alongside every `backgroundColor`.** The HTML attribute is the older, dumber
 *   mechanism, and it is the one Outlook's Word engine and several webmail sanitisers actually
 *   honour. Where a surface matters, it is declared twice on purpose.
 * - **`<Preview>`.** Without it, clients build the inbox snippet from whatever text comes first in
 *   the document, which is usually the heading repeated back.
 * - **The footer's identity block.** These are transactional messages from a company, so the
 *   sender has to be identifiable from the message itself: the legal name, the RUT, the address,
 *   an address to write back to, and the two documents that govern the relationship. It replaced a
 *   marketing tagline, which said nothing a recipient checking who wrote to them needs. The values
 *   come from `company.ts`, never from a template — a legal identity that varied by email is worse
 *   than none.
 *
 * There is still no `<style>` block, and there must not be one: the whole design has to survive a
 * client that keeps only inline attributes. That rules out `@media (prefers-color-scheme: dark)`,
 * which is why the palette is light-first instead (see `theme.ts`).
 */
const EmailLayout = ({ preview, heading, brandName = company.tradeName, logoSrc, children }: EmailLayoutProps) => (
  <Html lang="en">
    <Head>
      <meta name="color-scheme" content="light" />
      <meta name="supported-color-schemes" content="light" />
    </Head>
    <Preview>{preview}</Preview>
    <Body
      style={{
        margin: 0,
        padding: 0,
        backgroundColor: theme.colors.background,
        fontFamily: theme.fontFamily,
        WebkitFontSmoothing: 'antialiased',
      }}
    >
      {/*
        The page background is painted by this table, not only by `<body>`. Gmail and several
        webmail clients drop the `<body>` element and keep its children, so a background declared
        only there is a background the message does not have. The padding lives here for the same
        reason.
      */}
      <Section
        bgcolor={theme.colors.background}
        style={{ backgroundColor: theme.colors.background, padding: '32px 12px' }}
      >
        <Container
          bgcolor={theme.colors.surface}
          style={{
            maxWidth: theme.maxWidth,
            margin: '0 auto',
            backgroundColor: theme.colors.surface,
            border: `1px solid ${theme.colors.border}`,
            borderRadius: theme.radius,
            overflow: 'hidden',
          }}
        >
          {/*
            The brand gradient, as the only place it appears. The guidelines reserve it for tile
            fills and hero surfaces, and a 4 px rule across the head of the card is the smallest
            hero this layout has room for. `backgroundColor` is not a redundant declaration —
            Outlook drops the gradient and keeps the flat iris, which is the documented fallback.
          */}
          <Section
            bgcolor={theme.colors.accent}
            style={{
              backgroundColor: theme.colors.accent,
              backgroundImage: theme.gradient,
              height: '4px',
              lineHeight: '4px',
              fontSize: '4px',
            }}
          >
            <Text
              className={PLAIN_TEXT_SKIP_CLASS}
              style={{ margin: 0, height: '4px', lineHeight: '4px', fontSize: '4px' }}
            >
              &nbsp;
            </Text>
          </Section>
          <Section style={{ padding: '28px 32px 0' }}>
            <Img
              src={logoSrc ?? theme.logo.src}
              alt={theme.logo.alt}
              width={theme.logo.width}
              height={theme.logo.height}
              style={{ display: 'block', border: 'none', outline: 'none', textDecoration: 'none' }}
            />
          </Section>
          <Section style={{ padding: '24px 32px 8px' }}>
            <Heading
              as="h1"
              style={{
                margin: '0 0 16px',
                fontSize: '22px',
                fontWeight: 600,
                letterSpacing: '-0.2px',
                lineHeight: '1.3',
                color: theme.colors.heading,
              }}
            >
              {heading}
            </Heading>
            {children}
          </Section>
          <Section style={{ padding: '0 32px 28px' }}>
            <Hr style={{ margin: '0 0 16px', border: 'none', borderTop: `1px solid ${theme.colors.divider}` }} />
            <Text style={{ margin: '0 0 8px', fontSize: '13px', lineHeight: '1.6', color: theme.colors.body }}>
              {brandName}
              {' · '}
              <Link href={company.website} style={{ color: theme.colors.link, textDecoration: 'none' }}>
                {company.websiteLabel}
              </Link>
            </Text>
            {/*
              Who actually sent this. One `<Text>` per fact rather than one wrapped paragraph,
              because html-to-text keeps a block boundary as a line break — the plain-text part of
              the message gets the same four legible lines instead of one run-on sentence.
            */}
            <Text style={IDENTITY_LINE}>{company.legalName}</Text>
            {/* One expression, not `RUT {company.rut}`: React separates adjacent children with an
                HTML comment, and a comment in the middle of the number is a number no recipient can
                copy and no test can match. */}
            <Text style={IDENTITY_LINE}>{`RUT ${company.rut}`}</Text>
            <Text style={IDENTITY_LINE}>{company.addressLine}</Text>
            <Text style={IDENTITY_LINE}>
              <Link href={`mailto:${company.email}`} style={FOOTER_LINK}>
                {company.email}
              </Link>
            </Text>
            <Text style={{ ...IDENTITY_LINE, margin: '8px 0 0' }}>
              <Link href={company.termsUrl} style={FOOTER_LINK}>
                Terms of Service
              </Link>
              {' · '}
              <Link href={company.privacyUrl} style={FOOTER_LINK}>
                Privacy Policy
              </Link>
            </Text>
          </Section>
        </Container>
      </Section>
    </Body>
  </Html>
)

export { EmailLayout }
export type { EmailLayoutProps }
