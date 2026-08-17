/** @jsxImportSource react */
import { Body, Container, Head, Heading, Hr, Html, Preview, Section, Text } from '@react-email/components'
import type { ReactNode } from 'react'
import { theme } from '../theme'

type EmailLayoutProps = {
  /** Text shown in the inbox next to the subject. Never rendered in the body itself. */
  preview: string
  heading: string
  /** Name the footer signs off with. The apps pass their `MAIL_FROM_NAME`. */
  brandName?: string
  children: ReactNode
}

/**
 * The shell every template renders inside: one centred card on a dark page, no remote assets.
 *
 * `<Preview>` is not decoration — without it, clients build the inbox snippet from whatever text
 * comes first in the document, which is usually the heading repeated back.
 */
const EmailLayout = ({ preview, heading, brandName = 'Francisco Solis', children }: EmailLayoutProps) => (
  <Html lang="en">
    <Head />
    <Preview>{preview}</Preview>
    <Body style={{ margin: 0, padding: '24px', backgroundColor: theme.colors.background, fontFamily: theme.fontFamily }}>
      <Container
        style={{
          maxWidth: theme.maxWidth,
          margin: '0 auto',
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius,
        }}
      >
        <Section style={{ padding: '32px' }}>
          <Heading
            as="h1"
            style={{ margin: '0 0 16px', fontSize: '20px', lineHeight: '1.3', color: theme.colors.heading }}
          >
            {heading}
          </Heading>
          {children}
          <Hr style={{ margin: '32px 0 16px', border: 'none', borderTop: `1px solid ${theme.colors.border}` }} />
          <Text style={{ margin: 0, fontSize: '12px', lineHeight: '1.6', color: theme.colors.muted }}>
            {brandName} · franciscosolis.cl
          </Text>
        </Section>
      </Container>
    </Body>
  </Html>
)

export { EmailLayout }
export type { EmailLayoutProps }
