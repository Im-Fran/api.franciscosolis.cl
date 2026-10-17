/** @jsxImportSource react */
import { DetailRows } from '../components/detail-rows'
import { EmailLayout } from '../components/email-layout'
import { Paragraph } from '../components/paragraph'
import type { EmailLocale } from '../locale'
import { renderEmail, type RenderedEmail } from '../render'

type ContractNoticeEmailProps = {
  companyName: string
  contractName: string
  /** The last day the contract covers, already formatted by the sender. */
  endsOn: string
  /** The apps the contract covers, by name. */
  apps: string[]
  /** Days the apps keep working after the end before they are suspended. 0 suspends them at once. */
  graceDays: number
  locale?: EmailLocale
  brandName?: string
}

const copy = {
  en: {
    subject: (contract: string) => `Your contract “${contract}” is ending`,
    heading: 'Your contract is ending',
    intro: (company: string, endsOn: string) => `The maintenance contract of ${company} ends on ${endsOn} and is not set to renew.`,
    grace: (days: number) =>
      `If it is not renewed, the apps below keep working for ${days} more day${days === 1 ? '' : 's'} after that date, with a notice on screen, and are then suspended. Updates, maintenance and support are paused during that time.`,
    noGrace: 'If it is not renewed, the apps below are suspended when it ends.',
    renew: 'To renew it, or if you think this is a mistake, reply to this email.',
    labels: { contract: 'Contract', ends: 'Ends on', apps: 'Apps covered' },
  },
  es: {
    subject: (contract: string) => `Tu contrato “${contract}” está por terminar`,
    heading: 'Tu contrato está por terminar',
    intro: (company: string, endsOn: string) => `El contrato de mantención de ${company} termina el ${endsOn} y no se renueva solo.`,
    grace: (days: number) =>
      `Si no se renueva, las apps de abajo siguen funcionando ${days} día${days === 1 ? '' : 's'} más después de esa fecha, con un aviso en pantalla, y luego se suspenden. Durante ese periodo se pausan las actualizaciones, las mantenciones y el soporte.`,
    noGrace: 'Si no se renueva, las apps de abajo se suspenden cuando termine.',
    renew: 'Para renovarlo, o si crees que esto es un error, responde este correo.',
    labels: { contract: 'Contrato', ends: 'Termina el', apps: 'Apps cubiertas' },
  },
} as const

/**
 * The notice a client gets before a contract that does not renew itself ends.
 *
 * It names what happens to their apps, because that is the consequence they need to plan around —
 * a reminder that only says "your contract ends" invites them to ignore it and be surprised by a
 * suspended kiosk.
 */
const ContractNoticeEmail = ({ companyName, contractName, endsOn, apps, graceDays, locale = 'es', brandName }: ContractNoticeEmailProps) => {
  const t = copy[locale]
  return (
    <EmailLayout preview={t.heading} heading={t.heading} brandName={brandName}>
      <Paragraph>{t.intro(companyName, endsOn)}</Paragraph>
      <DetailRows
        rows={[
          { label: t.labels.contract, value: contractName },
          { label: t.labels.ends, value: endsOn },
          ...(apps.length > 0 ? [{ label: t.labels.apps, value: apps.join(', ') }] : []),
        ]}
      />
      <Paragraph>{graceDays > 0 ? t.grace(graceDays) : t.noGrace}</Paragraph>
      <Paragraph tone="muted">{t.renew}</Paragraph>
    </EmailLayout>
  )
}

ContractNoticeEmail.PreviewProps = {
  companyName: 'Comercial Andes SpA',
  contractName: 'Mantención mensual',
  endsOn: '30 de noviembre de 2026',
  apps: ['POS Andes', 'Tótem entrada'],
  graceDays: 15,
  locale: 'es',
} satisfies ContractNoticeEmailProps

const renderContractNoticeEmail = (props: ContractNoticeEmailProps): Promise<RenderedEmail> =>
  renderEmail(copy[props.locale ?? 'es'].subject(props.contractName), <ContractNoticeEmail {...props} />)

export { ContractNoticeEmail, renderContractNoticeEmail }
export type { ContractNoticeEmailProps }
export default ContractNoticeEmail
