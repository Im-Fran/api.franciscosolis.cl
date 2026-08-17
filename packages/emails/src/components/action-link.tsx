/** @jsxImportSource react */
import { Button, Link, Text } from '@react-email/components'
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
 */
const ActionLink = ({ href, label }: ActionLinkProps) => (
  <>
    <Button
      href={href}
      style={{
        display: 'inline-block',
        padding: '12px 24px',
        borderRadius: '8px',
        backgroundColor: theme.colors.accent,
        color: theme.colors.accentText,
        fontSize: '15px',
        fontWeight: 600,
        textDecoration: 'none',
      }}
    >
      {label}
    </Button>
    <Text style={{ margin: '24px 0 8px', fontSize: '13px', lineHeight: '1.6', color: theme.colors.muted }}>
      If the button does not work, copy this link into your browser:
    </Text>
    <Text style={{ margin: '0 0 24px', fontSize: '13px', lineHeight: '1.6', wordBreak: 'break-all' }}>
      <Link href={href} style={{ color: theme.colors.link }}>
        {href}
      </Link>
    </Text>
  </>
)

export { ActionLink }
export type { ActionLinkProps }
