/** @jsxImportSource react */
import { DetailRows } from '../components/detail-rows'
import { EmailLayout } from '../components/email-layout'
import { Paragraph } from '../components/paragraph'
import { formatDuration } from '../duration'
import type { EmailLocale } from '../locale'
import { renderEmail, type RenderedEmail } from '../render'

/**
 * Which notice it is:
 *
 * - `approved`: the client chose a window.
 * - `auto_applied`: nobody answered two requests, so it was scheduled in the first window still far
 *   enough away.
 * - `security`: a security patch, scheduled without approval — the advance notice.
 * - `reminder`: about 24 hours before the window.
 * - `completed`: it ended well.
 * - `failed`: it did not pass its checks and the devices stayed on (or went back to) what they ran.
 */
type MaintenanceNoticeStage = 'approved' | 'auto_applied' | 'security' | 'reminder' | 'completed' | 'failed'

type MaintenanceNoticeEmailProps = {
  stage: MaintenanceNoticeStage
  companyName: string
  appName: string
  title: string
  /** What will be done, shown before the work; left out of the outcome notices. */
  description?: string | null
  estimatedMinutes: number
  /** The window it runs in, already formatted by the sender (date, times and time zone). */
  window: string
  /** Who approved it, for `approved`. */
  approvedBy?: string | null
  /** The version installed, when the maintenance carried a release. */
  version?: string | null
  locale?: EmailLocale
  brandName?: string
}

type StageCopy = { subject: (title: string) => string; heading: string; intro: (app: string, company: string, extra: { approvedBy?: string | null; version?: string | null }) => string; after?: (extra: { version?: string | null }) => string }

const copy: Record<EmailLocale, { stages: Record<MaintenanceNoticeStage, StageCopy>; what: string; questions: string; labels: { app: string; maintenance: string; window: string; duration: string; approvedBy: string; version: string } }> = {
  en: {
    stages: {
      approved: {
        subject: (title) => `Maintenance confirmed: “${title}”`,
        heading: 'Maintenance confirmed',
        intro: (app, company, { approvedBy }) => `${approvedBy ? `${approvedBy} approved` : 'You approved'} the maintenance of ${app} (${company}). It will be carried out in this window:`,
        after: () => 'During the window the devices included show a maintenance notice. We will remind you about 24 hours before.',
      },
      auto_applied: {
        subject: (title) => `Maintenance scheduled: “${title}”`,
        heading: 'Maintenance scheduled',
        intro: (app, company) => `We asked twice and did not hear back about the maintenance of ${app} (${company}), so it was scheduled in the first window offered that is still at least 24 hours away:`,
        after: () => 'If this window does not suit you, reply to this email as soon as you can and we will move it.',
      },
      security: {
        subject: (title) => `Security patch notice: “${title}”`,
        heading: 'A security patch is scheduled',
        intro: (app, company) =>
          `We are applying a security patch to ${app} (${company}). Security patches do not wait for approval: as your contract sets out, they are applied within a few days, in the hours the app is used least. It is scheduled for:`,
        after: () => 'During the window the devices included show a maintenance notice. If this time is a problem, reply to this email.',
      },
      reminder: {
        subject: (title) => `Reminder: maintenance in 24 hours — “${title}”`,
        heading: 'The maintenance starts in about 24 hours',
        intro: (app, company) => `A reminder that the maintenance of ${app} (${company}) starts in about 24 hours:`,
        after: () => 'The devices included show a notice in the app in the meantime, and a maintenance screen during the window.',
      },
      completed: {
        subject: (title) => `Maintenance completed: “${title}”`,
        heading: 'Maintenance completed',
        intro: (app, company) => `The maintenance of ${app} (${company}) is done, and everything checked out.`,
        after: ({ version }) => (version ? `The devices included now run version ${version}.` : 'The app is back to normal.'),
      },
      failed: {
        subject: (title) => `The maintenance could not be completed: “${title}”`,
        heading: 'The maintenance could not be completed',
        intro: (app, company, { version }) =>
          version
            ? `The update of ${app} (${company}) to version ${version} did not pass its final checks, so the devices included went back to the version they ran before and keep working on it.`
            : `The maintenance of ${app} (${company}) could not be completed. The app keeps working as it did before.`,
        after: () => 'Nothing is needed on your side. We will look into it and get in touch to schedule it again.',
      },
    },
    what: 'What will be done',
    questions: 'If you have any questions, reply to this email.',
    labels: { app: 'App', maintenance: 'Maintenance', window: 'Window', duration: 'Estimated duration', approvedBy: 'Approved by', version: 'Version' },
  },
  es: {
    stages: {
      approved: {
        subject: (title) => `Mantención confirmada: “${title}”`,
        heading: 'Mantención confirmada',
        intro: (app, company, { approvedBy }) => `${approvedBy ? `${approvedBy} aprobó` : 'Aprobaste'} la mantención de ${app} (${company}). Se realizará en esta ventana:`,
        after: () => 'Durante la ventana los dispositivos incluidos muestran un aviso de mantención. Te recordaremos unas 24 horas antes.',
      },
      auto_applied: {
        subject: (title) => `Mantención agendada: “${title}”`,
        heading: 'Mantención agendada',
        intro: (app, company) => `Te consultamos dos veces por la mantención de ${app} (${company}) y no recibimos respuesta, así que se agendó en la primera ventana ofrecida que todavía está al menos a 24 horas:`,
        after: () => 'Si esta ventana no te sirve, responde este correo lo antes posible y la movemos.',
      },
      security: {
        subject: (title) => `Aviso de parche de seguridad: “${title}”`,
        heading: 'Se agendó un parche de seguridad',
        intro: (app, company) =>
          `Vamos a aplicar un parche de seguridad en ${app} (${company}). Los parches de seguridad no esperan aprobación: como establece tu contrato, se aplican dentro de pocos días, en el horario de menor uso de la app. Quedó agendado para:`,
        after: () => 'Durante la ventana los dispositivos incluidos muestran un aviso de mantención. Si este horario es un problema, responde este correo.',
      },
      reminder: {
        subject: (title) => `Recordatorio: mantención en 24 horas — “${title}”`,
        heading: 'La mantención empieza en unas 24 horas',
        intro: (app, company) => `Te recordamos que la mantención de ${app} (${company}) empieza en unas 24 horas:`,
        after: () => 'Mientras tanto, los dispositivos incluidos muestran un aviso en la app, y durante la ventana, una pantalla de mantención.',
      },
      completed: {
        subject: (title) => `Mantención completada: “${title}”`,
        heading: 'Mantención completada',
        intro: (app, company) => `La mantención de ${app} (${company}) terminó y todas las verificaciones salieron bien.`,
        after: ({ version }) => (version ? `Los dispositivos incluidos ya funcionan con la versión ${version}.` : 'La app volvió a la normalidad.'),
      },
      failed: {
        subject: (title) => `La mantención no se pudo completar: “${title}”`,
        heading: 'La mantención no se pudo completar',
        intro: (app, company, { version }) =>
          version
            ? `La actualización de ${app} (${company}) a la versión ${version} no pasó las verificaciones finales, así que los dispositivos incluidos volvieron a la versión que tenían antes y siguen funcionando con ella.`
            : `La mantención de ${app} (${company}) no se pudo completar. La app sigue funcionando como antes.`,
        after: () => 'No necesitas hacer nada. Lo revisaremos y te contactaremos para agendarla de nuevo.',
      },
    },
    what: 'Qué se hará',
    questions: 'Si tienes dudas, responde este correo.',
    labels: { app: 'App', maintenance: 'Mantención', window: 'Ventana', duration: 'Duración estimada', approvedBy: 'Aprobada por', version: 'Versión' },
  },
}

/**
 * Every notice about a scheduled maintenance after the request: that it is fixed (approved, applied
 * for lack of an answer, or a security patch's advance notice), the reminder, and how it ended.
 *
 * One template with a `stage` rather than six, because they are the same message at different moments
 * — the same facts in the same rows, so a client who keeps them can line them up. A failure says what
 * the devices run now before anything else: that is the question somebody reading it at the counter
 * has.
 */
const MaintenanceNoticeEmail = ({ stage, companyName, appName, title, description, estimatedMinutes, window, approvedBy, version, locale = 'es', brandName }: MaintenanceNoticeEmailProps) => {
  const t = copy[locale]
  const s = t.stages[stage]
  const beforeWork = stage !== 'completed' && stage !== 'failed'
  return (
    <EmailLayout preview={s.subject(title)} heading={s.heading} brandName={brandName}>
      <Paragraph>{s.intro(appName, companyName, { approvedBy, version })}</Paragraph>
      <DetailRows
        rows={[
          { label: t.labels.app, value: appName },
          { label: t.labels.maintenance, value: title },
          { label: t.labels.window, value: window },
          ...(beforeWork ? [{ label: t.labels.duration, value: formatDuration(estimatedMinutes, locale) }] : []),
          ...(stage === 'approved' && approvedBy ? [{ label: t.labels.approvedBy, value: approvedBy }] : []),
          ...(version ? [{ label: t.labels.version, value: version, mono: true }] : []),
        ]}
      />
      {beforeWork && description
        ? [
            <Paragraph key="what" tone="muted">
              {t.what}
            </Paragraph>,
            ...description
              .split(/\n+/)
              .map((line) => line.trim())
              .filter(Boolean)
              .map((line, index) => <Paragraph key={`line-${index}`}>{line}</Paragraph>),
          ]
        : null}
      {s.after ? <Paragraph>{s.after({ version })}</Paragraph> : null}
      <Paragraph tone="muted">{t.questions}</Paragraph>
    </EmailLayout>
  )
}

MaintenanceNoticeEmail.PreviewProps = {
  stage: 'approved',
  companyName: 'Comercial Andes SpA',
  appName: 'POS Andes',
  title: 'Actualización a la versión 2.4',
  description: 'Se instala la versión 2.4 del punto de venta, con el nuevo flujo de boletas.',
  estimatedMinutes: 90,
  window: 'martes, 3 de noviembre de 2026, 02:00–03:30 (hora de Santiago)',
  approvedBy: 'operaciones@andes.cl',
  version: '2.4.0',
  locale: 'es',
} satisfies MaintenanceNoticeEmailProps

const renderMaintenanceNoticeEmail = (props: MaintenanceNoticeEmailProps): Promise<RenderedEmail> =>
  renderEmail(copy[props.locale ?? 'es'].stages[props.stage].subject(props.title), <MaintenanceNoticeEmail {...props} />)

export { MaintenanceNoticeEmail, renderMaintenanceNoticeEmail }
export type { MaintenanceNoticeEmailProps, MaintenanceNoticeStage }
export default MaintenanceNoticeEmail
