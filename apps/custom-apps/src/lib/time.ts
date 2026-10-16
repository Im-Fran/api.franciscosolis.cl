import { ROLLUP } from '@/lib/config'

/**
 * Wall-clock arithmetic in Santiago.
 *
 * Everything a person reads here — a day's totals, an hour of the usage heatmap — is in Chilean
 * time, and Chile observes daylight saving, so a fixed UTC offset would be wrong for half the year.
 * `Intl` does the time-zone work; these helpers only reshape what it answers.
 */

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }

const WEEKDAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }

/** The calendar fields of `date` in `timeZone`. `weekday` is 0 for Monday through 6 for Sunday. */
const zonedParts = (date: Date, timeZone: string = ROLLUP.timeZone): ZonedParts => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(date)
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? Number.NaN)
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
    weekday: WEEKDAY_INDEX[parts.find((part) => part.type === 'weekday')?.value ?? ''] ?? Number.NaN,
  }
}

/** Minutes `timeZone` is ahead of UTC at `date` (negative west of Greenwich). */
const offsetMinutes = (date: Date, timeZone: string): number => {
  const parts = zonedParts(date, timeZone)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000)
}

const pad = (value: number) => String(value).padStart(2, '0')

/** `YYYY-MM-DD` of `date` in `timeZone`. */
const zonedDay = (date: Date, timeZone: string = ROLLUP.timeZone): string => {
  const { year, month, day } = zonedParts(date, timeZone)
  return `${year}-${pad(month)}-${pad(day)}`
}

/**
 * The UTC instant at which local midnight of `day` (`YYYY-MM-DD`) begins in `timeZone`.
 *
 * Computed by guessing with the offset at UTC midnight and correcting once with the offset at the
 * guess, which is exact unless a DST change falls in the same hours — Chile changes at midnight, so
 * the second reading is the one that applies.
 */
const startOfZonedDay = (day: string, timeZone: string = ROLLUP.timeZone): Date => {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  const utcMidnight = Date.UTC(year, month - 1, date)
  let instant = utcMidnight - offsetMinutes(new Date(utcMidnight), timeZone) * 60_000
  instant = utcMidnight - offsetMinutes(new Date(instant), timeZone) * 60_000
  return new Date(instant)
}

/** `[start, end)` of `day` in `timeZone`, as UTC instants. A DST day is 23 or 25 hours long. */
const zonedDayRange = (day: string, timeZone: string = ROLLUP.timeZone): { start: Date; end: Date } => {
  const start = startOfZonedDay(day, timeZone)
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  const next = new Date(Date.UTC(year, month - 1, date + 1))
  const nextDay = `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`
  return { start, end: startOfZonedDay(nextDay, timeZone) }
}

/** The day before `day`, as `YYYY-MM-DD`. Pure calendar arithmetic; no time zone involved. */
const previousDay = (day: string): string => {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  const previous = new Date(Date.UTC(year, month - 1, date - 1))
  return `${previous.getUTCFullYear()}-${pad(previous.getUTCMonth() + 1)}-${pad(previous.getUTCDate())}`
}

/** Every day from `from` to `to` inclusive, as `YYYY-MM-DD`. */
const daysBetween = (from: string, to: string): string[] => {
  const days: string[] = []
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number]
  const end = to
  for (let offset = 0; offset < 400; offset += 1) {
    const current = new Date(Date.UTC(fy, fm - 1, fd + offset))
    const day = `${current.getUTCFullYear()}-${pad(current.getUTCMonth() + 1)}-${pad(current.getUTCDate())}`
    if (day > end) break
    days.push(day)
  }
  return days
}

/** Unix seconds at the start of the UTC hour containing `seconds`. */
const hourStart = (seconds: number): number => seconds - (seconds % 3600)

/**
 * Splits `[from, to)` (unix seconds) into the UTC hours it covers, as `[hourStart, seconds]` pairs.
 * How a heartbeat's credit is filed when the interval it covers straddles the top of an hour.
 */
const splitByHour = (from: number, to: number): Array<[number, number]> => {
  const pieces: Array<[number, number]> = []
  let cursor = from
  while (cursor < to) {
    const start = hourStart(cursor)
    const end = Math.min(start + 3600, to)
    pieces.push([start, end - cursor])
    cursor = end
  }
  return pieces
}

export { daysBetween, hourStart, offsetMinutes, previousDay, splitByHour, startOfZonedDay, zonedDay, zonedDayRange, zonedParts }
