/** @jsxImportSource react */
import { Text } from '@react-email/components'
import type { ReactNode } from 'react'
import { theme } from '../theme'

type ParagraphProps = {
  children: ReactNode
  /** `muted` is for the small print under the action — a disclaimer, an expiry note. */
  tone?: 'body' | 'muted'
}

/**
 * Body copy at the one size and colour the templates agree on.
 *
 * `body` is ink, not a grey a shade off it. Grey body copy is the first thing a client's colour
 * rewriting turns illegible, and the brand reserves ink for exactly this. `muted` is the single
 * step down the palette allows and still clears AA on both surfaces a paragraph can land on.
 */
const Paragraph = ({ children, tone = 'body' }: ParagraphProps) => (
  <Text
    style={{
      margin: '0 0 24px',
      fontSize: tone === 'muted' ? '13px' : '16px',
      lineHeight: '1.65',
      color: tone === 'muted' ? theme.colors.muted : theme.colors.body,
    }}
  >
    {children}
  </Text>
)

export { Paragraph }
export type { ParagraphProps }
