/** @jsxImportSource react */
import { Section, Text } from 'react-email'
import { ActionLink } from '../components/action-link'
import { DetailRows } from '../components/detail-rows'
import { EmailLayout } from '../components/email-layout'
import { Paragraph } from '../components/paragraph'
import { formatDuration } from '../duration'
import type { EmailLocale } from '../locale'
import { renderEmail, type RenderedEmail } from '../render'
import { theme } from '../theme'

type MaintenanceRequestEmailProps = {
  companyName: string
  appName: string
  /** What the maintenance is, in a line. */
  title: string
  /** What will be done and what the client will notice, as the editor wrote it. Line breaks are kept. */
  description: string
  estimatedMinutes: number
  /** The windows offered, in order, each already formatted by the sender (date, times and time zone). */
  windows: string[]
  /** The single-use approval page. */
  url: string
  /** When the link stops working — the first window's start — already formatted by the sender. */
  expiresAt: string
  /** The second send: the client did not answer the first. */
  reminder?: boolean
  locale?: EmailLocale
  brandName?: string
}

const copy = {
  en: {
    subject: (title: string, reminder: boolean) => (reminder ? `Reminder: please choose a window for “${title}”` : `Please choose a window for a maintenance: “${title}”`),
    heading: (reminder: boolean) => (reminder ? 'We still need your answer' : 'A maintenance needs your approval'),
    intro: (company: string, app: string, reminder: boolean) =>
      reminder
        ? `We have not heard back about the maintenance of ${app} (${company}) we asked you to schedule. Please choose one of the windows below, or tell us why it does not suit you.`
        : `We need to carry out a maintenance of ${app} (${company}). Please choose the window that suits you best, or tell us why none does.`,
    what: 'What will be done',
    windows: 'Windows offered',
    action: 'Choose a window',
    hint: 'If the button does not work, copy this link into your browser:',
    expiry: (expiresAt: string) => `The link works until ${expiresAt}, when the first window starts.`,
    unanswered:
      'If we do not hear from you, we will send this request once more; after that, the maintenance is scheduled in the first window still at least 24 hours away, and we will let you know.',
    labels: { app: 'App', maintenance: 'Maintenance', duration: 'Estimated duration' },
  },
  es: {
    subject: (title: string, reminder: boolean) => (reminder ? `Recordatorio: elige una ventana para “${title}”` : `Elige una ventana para una mantención: “${title}”`),
    heading: (reminder: boolean) => (reminder ? 'Aún necesitamos tu respuesta' : 'Una mantención necesita tu aprobación'),
    intro: (company: string, app: string, reminder: boolean) =>
      reminder
        ? `No hemos recibido respuesta sobre la mantención de ${app} (${company}) que te pedimos agendar. Elige una de las ventanas de abajo, o cuéntanos por qué no te sirven.`
        : `Necesitamos realizar una mantención de ${app} (${company}). Elige la ventana que más te acomode, o cuéntanos por qué ninguna te sirve.`,
    what: 'Qué se hará',
    windows: 'Ventanas ofrecidas',
    action: 'Elegir una ventana',
    hint: 'Si el botón no funciona, copia este enlace en tu navegador:',
    expiry: (expiresAt: string) => `El enlace funciona hasta el ${expiresAt}, cuando empieza la primera ventana.`,
    unanswered:
      'Si no recibimos respuesta, te enviaremos esta solicitud una vez más; después, la mantención se agenda en la primera ventana que todavía esté al menos a 24 horas, y te avisaremos.',
    labels: { app: 'App', maintenance: 'Mantención', duration: 'Duración estimada' },
  },
} as const

/**
 * The approval request for a scheduled maintenance, sent to the client's maintenance approver.
 *
 * It says what will be done and how long it takes before it asks for anything, because a window is
 * only a sensible choice once the recipient knows what it costs them. The windows are listed in the
 * body as well as on the page: the recipient can check them against a calendar without clicking, and
 * the list survives a gateway that strips the button. The second send says it is the second, and both
 * say what happens without an answer — applying it on its own is only fair if they were told.
 */
const MaintenanceRequestEmail = ({
  companyName,
  appName,
  title,
  description,
  estimatedMinutes,
  windows,
  url,
  expiresAt,
  reminder = false,
  locale = 'es',
  brandName,
}: MaintenanceRequestEmailProps) => {
  const t = copy[locale]
  return (
    <EmailLayout preview={t.subject(title, reminder)} heading={t.heading(reminder)} brandName={brandName}>
      <Paragraph>{t.intro(companyName, appName, reminder)}</Paragraph>
      <DetailRows
        rows={[
          { label: t.labels.app, value: appName },
          { label: t.labels.maintenance, value: title },
          { label: t.labels.duration, value: formatDuration(estimatedMinutes, locale) },
        ]}
      />
      <Text style={{ margin: '0 0 8px', fontSize: '13px', lineHeight: '1.6', color: theme.colors.muted, fontWeight: 600 }}>{t.what}</Text>
      {description
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => (
          <Paragraph key={`line-${index}`}>{line}</Paragraph>
        ))}
      <Text style={{ margin: '0 0 8px', fontSize: '13px', lineHeight: '1.6', color: theme.colors.muted, fontWeight: 600 }}>{t.windows}</Text>
      <Section style={{ margin: '0 0 24px' }}>
        {windows.map((window, index) => (
          <Text key={window} style={{ margin: '0 0 4px', fontSize: '15px', lineHeight: '1.6', color: theme.colors.body }}>
            {`${index + 1}. ${window}`}
          </Text>
        ))}
      </Section>
      <ActionLink href={url} label={t.action} hint={t.hint} />
      <Paragraph tone="muted">{t.expiry(expiresAt)}</Paragraph>
      <Paragraph tone="muted">{t.unanswered}</Paragraph>
    </EmailLayout>
  )
}

MaintenanceRequestEmail.PreviewProps = {
  companyName: 'Comercial Andes SpA',
  appName: 'POS Andes',
  title: 'Actualización a la versión 2.4',
  description: 'Se instala la versión 2.4 del punto de venta, con el nuevo flujo de boletas.\nDurante la ventana las cajas incluidas muestran un aviso de mantención y no pueden vender.',
  estimatedMinutes: 90,
  windows: ['martes, 3 de noviembre de 2026, 02:00–03:30 (hora de Santiago)', 'miércoles, 4 de noviembre de 2026, 03:00–04:30 (hora de Santiago)'],
  url: 'https://franciscosolis.cl/mantencion/mnt_preview-token',
  expiresAt: 'martes, 3 de noviembre de 2026, 02:00',
  locale: 'es',
} satisfies MaintenanceRequestEmailProps

const renderMaintenanceRequestEmail = (props: MaintenanceRequestEmailProps): Promise<RenderedEmail> =>
  renderEmail(copy[props.locale ?? 'es'].subject(props.title, props.reminder ?? false), <MaintenanceRequestEmail {...props} />)

export { MaintenanceRequestEmail, renderMaintenanceRequestEmail }
export type { MaintenanceRequestEmailProps }
export default MaintenanceRequestEmail
