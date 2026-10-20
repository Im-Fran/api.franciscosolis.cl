import type { EmailLocale } from './locale'

/**
 * A duration in whole minutes as a person says it: "2 horas", "1 hora y 30 minutos", "45 minutes".
 *
 * Unlike a date this needs no time zone or calendar, so it is done here rather than by the sender —
 * the same reasoning as `formatMoney`, and the same rule that the input is already an integer.
 */
const formatDuration = (minutes: number, locale: EmailLocale = 'es') => {
  const total = Math.max(0, Math.round(minutes))
  const hours = Math.floor(total / 60)
  const rest = total % 60
  if (locale === 'es') {
    const h = hours === 1 ? '1 hora' : `${hours} horas`
    const m = rest === 1 ? '1 minuto' : `${rest} minutos`
    if (hours === 0) return m
    return rest === 0 ? h : `${h} y ${m}`
  }
  const h = hours === 1 ? '1 hour' : `${hours} hours`
  const m = rest === 1 ? '1 minute' : `${rest} minutes`
  if (hours === 0) return m
  return rest === 0 ? h : `${h} ${m}`
}

export { formatDuration }
