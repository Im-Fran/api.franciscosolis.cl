/** @jsxImportSource react */
import { Text } from '@react-email/components'
import type { ReactNode } from 'react'
import { theme } from '../theme'

type ParagraphProps = {
  children: ReactNode
  /** `muted` is for the small print under the action — a disclaimer, an expiry note. */
  tone?: 'body' | 'muted'
}

/** Body copy at the one size and colour the templates agree on. */
const Paragraph = ({ children, tone = 'body' }: ParagraphProps) => (
  <Text
    style={{
      margin: '0 0 24px',
      fontSize: tone === 'muted' ? '13px' : '15px',
      lineHeight: '1.6',
      color: tone === 'muted' ? theme.colors.muted : theme.colors.body,
    }}
  >
    {children}
  </Text>
)

export { Paragraph }
export type { ParagraphProps }
