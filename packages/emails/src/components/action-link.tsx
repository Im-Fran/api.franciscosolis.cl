/** @jsxImportSource react */
import { Button, Link, Section, Text } from 'react-email'
import { theme } from '../theme'

type ActionLinkProps = {
  href: string
  label: string
}

/**
 * A call-to-action button plus the same URL in plain sight.
 *
 * The visible copy of the link is not redundancy for its own sake: corporate mail gateways rewrite
 * or strip `<a>` elements often enough that a button-only email is a dead end for the recipient,
 * and every URL these templates carry is single-use, so "just request another one" is a real cost.
 *
 * It sits in a tinted panel rather than loose in the column because a bare 300-character URL
 * wrapped over four lines reads as damage. The panel is `iris-050`, the brand's tinted surface, and
 * the link on it still clears AA at 5.4:1.
 *
 * `<Button>` is react-email's, not a bare `<a>`: Outlook's Word engine ignores padding on an
 * anchor, and the component emits the conditional-comment spacer that gives the label its hit area
 * there. The button is also the only element in these emails that reverses the palette, so its
 * `backgroundColor` is repeated as a `bgcolor` attribute — a sanitiser that drops the inline style
 * and keeps the white label would otherwise leave white text on white.
 */
const ActionLink = ({ href, label }: ActionLinkProps) => (
  <>
    <Button
      href={href}
      style={{
        display: 'inline-block',
        padding: '14px 28px',
        borderRadius: theme.radiusInner,
        backgroundColor: theme.colors.accent,
        color: theme.colors.accentText,
        fontSize: '15px',
        fontWeight: 600,
        lineHeight: '1',
        textDecoration: 'none',
      }}
    >
      {label}
    </Button>
    <Text style={{ margin: '24px 0 8px', fontSize: '13px', lineHeight: '1.6', color: theme.colors.muted }}>
      If the button does not work, copy this link into your browser:
    </Text>
    <Section
      bgcolor={theme.colors.surfaceTinted}
      style={{
        margin: '0 0 24px',
        padding: '12px 14px',
        backgroundColor: theme.colors.surfaceTinted,
        border: `1px solid ${theme.colors.border}`,
        borderRadius: theme.radiusInner,
      }}
    >
      <Text style={{ margin: 0, fontSize: '13px', lineHeight: '1.6', wordBreak: 'break-all' }}>
        <Link href={href} style={{ color: theme.colors.link }}>
          {href}
        </Link>
      </Text>
    </Section>
  </>
)

export { ActionLink }
export type { ActionLinkProps }
