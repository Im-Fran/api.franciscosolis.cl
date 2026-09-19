/** @jsxImportSource react */
import { Row, Column, Section, Text } from 'react-email'
import type { ReactNode } from 'react'
import { theme } from '../theme'

type DetailRow = {
  label: string
  value: ReactNode
  /** Renders the value in a monospace face. For a reference, an id, an amount. */
  mono?: boolean
}

type DetailRowsProps = {
  rows: DetailRow[]
}

/**
 * A label/value block for the facts a receipt has to state.
 *
 * It is a `<table>` rather than a definition list because Outlook's Word engine ignores `display`
 * on anything, so a two-column layout that is not a table is a two-line layout there. Each pair is
 * its own `<Row>` for the same reason a media query is absent from these templates: a phone gets
 * the label above the value only if the client supports stacking, and Word never will — two narrow
 * columns read correctly at every width, a stacked layout that silently does not is worse.
 *
 * The tinted panel is the same one `ActionLink` puts a URL in, so a receipt and a link block read
 * as the same kind of aside rather than two inventions.
 *
 * Values are rendered as React children and therefore escaped. Several of them — an address, a
 * note an editor typed on a manual sale — are free text that reached us from outside.
 */
const DetailRows = ({ rows }: DetailRowsProps) => (
  <Section
    bgcolor={theme.colors.surfaceTinted}
    style={{
      margin: '0 0 24px',
      padding: '16px 18px',
      borderRadius: theme.radiusInner,
      backgroundColor: theme.colors.surfaceTinted,
    }}
  >
    {rows.map((row) => (
      <Row key={row.label}>
        <Column style={{ padding: '4px 12px 4px 0', verticalAlign: 'top', width: '42%' }}>
          <Text style={{ margin: 0, fontSize: '13px', lineHeight: '1.6', color: theme.colors.muted }}>
            {row.label}
          </Text>
        </Column>
        <Column style={{ padding: '4px 0', verticalAlign: 'top' }}>
          <Text
            style={{
              margin: 0,
              fontSize: '13px',
              lineHeight: '1.6',
              color: theme.colors.body,
              fontWeight: 600,
              ...(row.mono ? { fontFamily: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" } : {}),
            }}
          >
            {row.value}
          </Text>
        </Column>
      </Row>
    ))}
  </Section>
)

export { DetailRows }
export type { DetailRow, DetailRowsProps }
