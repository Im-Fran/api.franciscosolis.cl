import { MAINTENANCES, ROLLUP, WEEKDAYS, type Weekday } from '@/lib/config'

/**
 * Where a maintenance window goes: the arithmetic behind the panel's suggestions and the window a
 * security patch picks for itself. Pure — the heatmap and the app's hours are passed in — so it is
 * tested without a database.
 *
 * **Blocks start on the hour.** The usage heatmap is hourly (Santiago weekday × hour), and a UTC hour
 * is exactly one Santiago hour whatever daylight saving says, so a block starting at a UTC hour covers
 * whole heatmap cells. A block is the estimated duration long; it is *scored* on every hour it touches
 * (the duration rounded up to whole hours), as the sum of those cells: the seconds of use an average
 * such stretch of the week saw. Zero is a stretch nobody used in the last 30 days.
 *
 * **Operating hours restrict, they do not exclude.** When an app declares them, a block must lie
 * entirely inside them: outside its hours a kiosk may be switched off, and a device that is off cannot
 * install anything. An app without declared hours is assumed on around the clock.
 */

type OperatingWindow = { start: string; end: string }
type OperatingHours = { timezone?: string; days: Partial<Record<Weekday, OperatingWindow[]>> }

/** `cells[weekday][hour]`, Monday first, Santiago time — `usageHeatmap`'s `cells`. */
type Heatmap = number[][]

/** `[start, end)` in unix seconds. */
type Interval = { start: number; end: number }

type Candidate = { start: number; end: number; score: number }

const HOUR = 3600

const minutesOf = (value: string) => {
  const [hours, minutes] = value.split(':').map(Number) as [number, number]
  return hours * 60 + minutes
}

/** One formatter per time zone, reused: building an `Intl.DateTimeFormat` is the expensive part. */
const formatters = new Map<string, Intl.DateTimeFormat>()
const formatterFor = (timeZone: string) => {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

const WEEKDAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }

/** Weekday (0 = Monday) and minute of the day of `seconds` in `timeZone`. */
const localSlot = (seconds: number, timeZone: string) => {
  const parts = formatterFor(timeZone).formatToParts(new Date(seconds * 1000))
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return { weekday: WEEKDAY_INDEX[read('weekday')] ?? 0, minute: Number(read('hour')) * 60 + Number(read('minute')) }
}

/** Each weekday's windows in minutes, sorted, with touching or overlapping ones merged. */
const normaliseHours = (hours: OperatingHours) =>
  WEEKDAYS.map((day) => {
    const windows = [...(hours.days[day] ?? [])].map((window) => ({ start: minutesOf(window.start), end: minutesOf(window.end) })).sort((a, b) => a.start - b.start)
    const merged: Array<{ start: number; end: number }> = []
    for (const window of windows) {
      const last = merged.at(-1)
      if (last && window.start <= last.end) last.end = Math.max(last.end, window.end)
      else merged.push({ ...window })
    }
    return merged
  })

/** Whether `minutes` minutes from `minute` on `weekday` lie inside one declared window. */
const insideDay = (days: ReturnType<typeof normaliseHours>, weekday: number, minute: number, minutes: number) =>
  (days[weekday] ?? []).some((window) => window.start <= minute && minute + minutes <= window.end)

/**
 * Whether `[start, end)` lies inside the declared hours, checked hour by hour in the hours' own time
 * zone, and split at local midnight so a block running from Monday 22:00 into Tuesday 02:00 needs both
 * days' windows. Null hours are always open.
 */
const withinOperatingHours = (hours: OperatingHours | null, interval: Interval) => {
  if (!hours) return true
  const days = normaliseHours(hours)
  const zone = hours.timezone ?? ROLLUP.timeZone
  for (let cursor = interval.start; cursor < interval.end; ) {
    const next = Math.min(interval.end, Math.floor(cursor / HOUR) * HOUR + HOUR)
    const slot = localSlot(cursor, zone)
    let minutes = Math.ceil((next - cursor) / 60)
    const beforeMidnight = Math.min(minutes, 1440 - slot.minute)
    if (!insideDay(days, slot.weekday, slot.minute, beforeMidnight)) return false
    minutes -= beforeMidnight
    if (minutes > 0 && !insideDay(days, (slot.weekday + 1) % 7, 0, minutes)) return false
    cursor = next
  }
  return true
}

/** The heatmap cell an hour falls in, read off Santiago's clock. */
const cellOf = (heatmap: Heatmap, hourStart: number) => {
  const slot = localSlot(hourStart, ROLLUP.timeZone)
  return heatmap[slot.weekday]?.[Math.floor(slot.minute / 60)] ?? 0
}

/** A block's score: the heatmap cells of every hour it touches, summed. */
const blockScore = (heatmap: Heatmap, start: number, minutes: number) => {
  let score = 0
  for (let hour = 0; hour < Math.ceil(minutes / 60); hour += 1) score += cellOf(heatmap, start + hour * HOUR)
  return score
}

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end

type CandidateInput = {
  heatmap: Heatmap
  operatingHours: OperatingHours | null
  /** Unix seconds. */
  now: number
  estimatedMinutes: number
  /** The earliest a block may start, in seconds from `now`. */
  minLeadSeconds: number
  /** The latest a block may end, in seconds from `now`. */
  horizonSeconds: number
}

/** Every block on the hour between the lead and the horizon that fits the operating hours, scored, earliest first. */
const candidates = (input: CandidateInput): Candidate[] => {
  const length = input.estimatedMinutes * 60
  const first = Math.ceil((input.now + input.minLeadSeconds) / HOUR) * HOUR
  const last = input.now + input.horizonSeconds - length
  const scores = new Map<number, number>()
  const found: Candidate[] = []
  for (let start = first; start <= last; start += HOUR) {
    const interval = { start, end: start + length }
    if (!withinOperatingHours(input.operatingHours, interval)) continue
    // Each hour's cell is read once, however many blocks cover it.
    let score = 0
    for (let hour = 0; hour < Math.ceil(input.estimatedMinutes / 60); hour += 1) {
      const at = start + hour * HOUR
      let cell = scores.get(at)
      if (cell === undefined) {
        cell = cellOf(input.heatmap, at)
        scores.set(at, cell)
      }
      score += cell
    }
    found.push({ ...interval, score })
  }
  return found
}

type SuggestInput = Omit<CandidateInput, 'minLeadSeconds' | 'horizonSeconds'> & {
  /** Windows the maintenance already offers; a suggestion never overlaps one. */
  existing?: Interval[]
  count?: number
  days?: number
  minLeadHours?: number
}

/**
 * The panel's suggestions: the `count` least-used blocks of the next `days` days, each starting at
 * least `minLeadHours` from now, none overlapping another or a window already offered. Ties go to the
 * earliest. Answered best first.
 */
const suggestWindows = (input: SuggestInput): Candidate[] => {
  const all = candidates({
    ...input,
    minLeadSeconds: (input.minLeadHours ?? MAINTENANCES.minLeadHours) * HOUR,
    horizonSeconds: (input.days ?? MAINTENANCES.suggestDays) * 86_400,
  }).sort((a, b) => a.score - b.score || a.start - b.start)
  const taken: Interval[] = [...(input.existing ?? [])]
  const picked: Candidate[] = []
  for (const candidate of all) {
    if (picked.length >= (input.count ?? MAINTENANCES.suggestCount)) break
    if (taken.some((interval) => overlaps(interval, candidate))) continue
    picked.push(candidate)
    taken.push(candidate)
  }
  return picked
}

type SecurityInput = Omit<CandidateInput, 'minLeadSeconds' | 'horizonSeconds'> & {
  /** The contract's `security_patch_days`. */
  days: number
  minLeadMinutes?: number
}

/**
 * A security patch's window: the first block within `days` days in which nobody used the app in the
 * last 30 days, or, when there is none, the least-used one (the earliest of equals). Null when no
 * block fits at all — the operating hours leave no room for the duration.
 */
const securityWindow = (input: SecurityInput): Candidate | null => {
  const all = candidates({
    ...input,
    minLeadSeconds: (input.minLeadMinutes ?? MAINTENANCES.securityMinLeadMinutes) * 60,
    horizonSeconds: input.days * 86_400,
  })
  const unused = all.find((candidate) => candidate.score === 0)
  if (unused) return unused
  return all.reduce<Candidate | null>((best, candidate) => (!best || candidate.score < best.score ? candidate : best), null)
}

export { blockScore, overlaps, securityWindow, suggestWindows, withinOperatingHours }
export type { Candidate, Heatmap, Interval, OperatingHours }
