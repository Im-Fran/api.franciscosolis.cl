/** @jsxImportSource react */
import { Section, Text } from 'react-email'
import { DetailRows } from '../components/detail-rows'
import { EmailLayout } from '../components/email-layout'
import { Paragraph } from '../components/paragraph'
import type { EmailLocale } from '../locale'
import { renderEmail, type RenderedEmail } from '../render'
import { theme } from '../theme'

type SupportRequestEmailProps = {
  subject: string
  message: string
  /** Who wrote it, as they typed it in the app. Either may be missing. */
  requesterName: string | null
  requesterEmail: string | null
  companyName: string
  appName: string
  /** Facts about the device, already formatted: label and value. */
  device: Array<{ label: string; value: string }>
  /** The most recent log lines, oldest first, already formatted. Empty when the app sends no logs. */
  logs: string[]
  /** Open crash groups of the running version, already formatted. */
  crashes: string[]
  /** Link to the installation in the panel. */
  panelUrl: string | null
  locale?: EmailLocale
  brandName?: string
}

const copy = {
  en: {
    subject: (app: string, subject: string) => `[${app}] ${subject}`,
    heading: 'Support request from an app',
    from: (who: string) => `Sent from the app by ${who}.`,
    anonymous: 'Sent from the app without a name or an address: reply through the client’s usual channel.',
    labels: { company: 'Client', app: 'App' },
    device: 'Device',
    logs: 'Recent logs',
    crashes: 'Open crashes on this version',
    panel: (url: string) => `Installation in the panel: ${url}`,
  },
  es: {
    subject: (app: string, subject: string) => `[${app}] ${subject}`,
    heading: 'Solicitud de soporte desde una app',
    from: (who: string) => `Enviada desde la app por ${who}.`,
    anonymous: 'Enviada desde la app sin nombre ni correo: responde por el canal habitual del cliente.',
    labels: { company: 'Cliente', app: 'App' },
    device: 'Dispositivo',
    logs: 'Logs recientes',
    crashes: 'Crashes abiertos en esta versión',
    panel: (url: string) => `Instalación en el panel: ${url}`,
  },
} as const

const PRE = {
  margin: '0 0 24px',
  padding: '12px 14px',
  fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
  fontSize: '12px',
  lineHeight: '1.5',
  whiteSpace: 'pre-wrap' as const,
  wordBreak: 'break-word' as const,
  color: theme.colors.body,
  backgroundColor: theme.colors.surfaceTinted,
  borderRadius: theme.radiusInner,
}

/**
 * A support request typed into a client's app, delivered to the support inbox.
 *
 * Support is plain email by decision: nothing keeps this as a ticket, so everything needed to answer
 * it travels in the message — who wrote it, which device it came from, what that device was doing.
 * The reply goes to the requester directly (the sender sets `Reply-To`).
 */
const SupportRequestEmail = (props: SupportRequestEmailProps) => {
  const t = copy[props.locale ?? 'es']
  const who = [props.requesterName, props.requesterEmail].filter(Boolean).join(' · ')
  return (
    <EmailLayout preview={props.subject} heading={t.heading} brandName={props.brandName}>
      <Paragraph>{who ? t.from(who) : t.anonymous}</Paragraph>
      <DetailRows
        rows={[
          { label: t.labels.company, value: props.companyName },
          { label: t.labels.app, value: props.appName },
        ]}
      />
      <Text style={PRE}>{props.message}</Text>
      <Paragraph tone="muted">{t.device}</Paragraph>
      <DetailRows rows={props.device.map((row) => ({ label: row.label, value: row.value, mono: true }))} />
      {props.crashes.length > 0 && (
        <Section>
          <Paragraph tone="muted">{t.crashes}</Paragraph>
          <Text style={PRE}>{props.crashes.join('\n')}</Text>
        </Section>
      )}
      {props.logs.length > 0 && (
        <Section>
          <Paragraph tone="muted">{t.logs}</Paragraph>
          <Text style={PRE}>{props.logs.join('\n')}</Text>
        </Section>
      )}
      {props.panelUrl && <Paragraph tone="muted">{t.panel(props.panelUrl)}</Paragraph>}
    </EmailLayout>
  )
}

SupportRequestEmail.PreviewProps = {
  subject: 'La impresora no imprime boletas',
  message: 'Desde esta mañana la impresora de la caja 2 no imprime. Ya la reiniciamos.',
  requesterName: 'María Pérez',
  requesterEmail: 'maria@andes.cl',
  companyName: 'Comercial Andes SpA',
  appName: 'POS Andes',
  device: [
    { label: 'Instalación', value: 'Caja 2' },
    { label: 'Versión', value: '1.4.0 (stable)' },
    { label: 'Sistema', value: 'Windows 11 · x86_64' },
    { label: 'Último contacto', value: '2026-10-17 10:42' },
  ],
  logs: ['10:41:02 error printer: COM3 not responding', '10:41:05 warning printer: retrying'],
  crashes: ['panic: called `Option::unwrap()` on a `None` value (3 times)'],
  panelUrl: 'https://franciscosolis.cl/custom-apps/installations/00000000-0000-0000-0000-000000000000',
  locale: 'es',
} satisfies SupportRequestEmailProps

const renderSupportRequestEmail = (props: SupportRequestEmailProps): Promise<RenderedEmail> =>
  renderEmail(copy[props.locale ?? 'es'].subject(props.appName, props.subject), <SupportRequestEmail {...props} />)

export { renderSupportRequestEmail, SupportRequestEmail }
export type { SupportRequestEmailProps }
export default SupportRequestEmail
