/**
 * Calendar dates as `YYYY-MM-DD` strings, which is what the Banco Central de Chile API takes and
 * what this Worker answers with.
 *
 * The central bank publishes on Chilean days, so "today" is today in Santiago rather than in UTC:
 * between 20:00 and midnight in Chile (UTC-4) or 21:00 (UTC-3) the UTC date is already tomorrow,
 * and asking for tomorrow's UF would serve a value that is not in force yet.
 */
const SANTIAGO_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Santiago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

const DAY_MS = 86_400_000

const santiagoToday = (now: Date = new Date()): string => SANTIAGO_DAY.format(now)

/** Parses a `YYYY-MM-DD` string into a UTC midnight, or `null` for anything that is not a real day. */
const parseIsoDate = (value: string): Date | null => {
  const match = ISO_DATE.exec(value)
  if (!match) return null

  const [, year, month, day] = match.map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))

  // `Date.UTC` rolls 2026-02-30 over into March rather than refusing it.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null
  }
  return date
}

const isIsoDate = (value: string): boolean => parseIsoDate(value) !== null

const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10)

/** Moves a `YYYY-MM-DD` date by a whole number of days. The input is assumed valid. */
const shiftDays = (value: string, days: number): string =>
  toIsoDate(new Date((parseIsoDate(value) as Date).getTime() + days * DAY_MS))

/** Whole days from `from` to `to`; negative when `to` comes first. Both inputs are assumed valid. */
const daysBetween = (from: string, to: string): number =>
  Math.round(((parseIsoDate(to) as Date).getTime() - (parseIsoDate(from) as Date).getTime()) / DAY_MS)

export { daysBetween, isIsoDate, parseIsoDate, santiagoToday, shiftDays }
