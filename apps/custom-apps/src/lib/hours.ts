import type { Currency, CyclePeriod } from '@/lib/config'

/**
 * The arithmetic of a contract's hours: where a cycle begins and ends, and what is left over when
 * one closes. Pure functions over calendar days (`YYYY-MM-DD`) and whole minutes, so every rule here
 * is a unit test away from being checked — money and hours are not the place for a float drifting.
 */

const pad = (value: number) => String(value).padStart(2, '0')

const toDay = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`

const parts = (day: string) => day.split('-').map(Number) as [number, number, number]

/** `day` moved by `days` calendar days. */
const addDays = (day: string, days: number): string => {
  const [year, month, date] = parts(day)
  return toDay(new Date(Date.UTC(year, month - 1, date + days)))
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
const daysBetween = (from: string, to: string): number => {
  const [fy, fm, fd] = parts(from)
  const [ty, tm, td] = parts(to)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}

const daysInMonth = (year: number, monthIndex: number) => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()

/**
 * `anchor` moved by `months`, keeping its day of the month where the target month has it and
 * clamping to the month's last day where it does not — and always from the anchor, never from the
 * previous result, so a contract starting on the 31st comes back to the 31st after February.
 */
const addMonths = (anchor: string, months: number): string => {
  const [year, month, date] = parts(anchor)
  const target = new Date(Date.UTC(year, month - 1 + months, 1))
  const day = Math.min(date, daysInMonth(target.getUTCFullYear(), target.getUTCMonth()))
  return toDay(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day)))
}

/** The start of the `index`-th cycle of a contract that started on `anchor`. */
const cycleStart = (period: CyclePeriod, anchor: string, index: number): string => {
  if (period === 'daily') return addDays(anchor, index)
  if (period === 'weekly') return addDays(anchor, index * 7)
  return addMonths(anchor, index)
}

/**
 * `[starts_on, ends_on)` of the cycle containing `day`, for a contract that started on `anchor` and,
 * when it has one, ends on `contractEnd` (inclusive): the last cycle is cut short at the contract's
 * end rather than running past it. Null when `day` is before the contract began or after it ended.
 */
const cycleContaining = (period: CyclePeriod, anchor: string, day: string, contractEnd: string | null = null) => {
  if (day < anchor || (contractEnd && day > contractEnd)) return null
  let index: number
  if (period === 'daily') index = daysBetween(anchor, day)
  else if (period === 'weekly') index = Math.floor(daysBetween(anchor, day) / 7)
  else {
    const [ay, am] = parts(anchor)
    const [dy, dm] = parts(day)
    index = (dy - ay) * 12 + (dm - am)
    if (cycleStart(period, anchor, index) > day) index -= 1
  }
  const startsOn = cycleStart(period, anchor, index)
  let endsOn = cycleStart(period, anchor, index + 1)
  if (contractEnd && endsOn > addDays(contractEnd, 1)) endsOn = addDays(contractEnd, 1)
  return { startsOn, endsOn }
}

/**
 * The cycle that opens on `from`. Normally `from` is a period boundary and this is the whole
 * period. It is not when a contract that ended mid-period is renewed: its last cycle was cut short
 * at the old end, so the next one opens mid-period. That cycle runs to the next boundary, so the
 * anchor still holds, and gets the share of `includedMinutes` its days are of the full period's
 * (rounded to whole minutes), so a few days never hand out a whole period's minutes.
 */
const cycleOpeningOn = (period: CyclePeriod, anchor: string, from: string, includedMinutes: number, contractEnd: string | null = null) => {
  const bounds = cycleContaining(period, anchor, from, contractEnd)
  if (!bounds) return null
  if (bounds.startsOn === from) return { ...bounds, includedMinutes }
  const full = cycleContaining(period, anchor, from) as { startsOn: string; endsOn: string }
  const share = daysBetween(from, bounds.endsOn) / daysBetween(full.startsOn, full.endsOn)
  return { startsOn: from, endsOn: bounds.endsOn, includedMinutes: Math.round(includedMinutes * share) }
}

/**
 * Hours carried from earlier cycles, one bucket per cycle they came from. Kept apart rather than as
 * one sum because they age separately: a contract that lets hours accumulate for three cycles has to
 * know which of them are on their third.
 */
type CarriedBucket = {
  /** Start of the cycle these minutes were included in. */
  from: string
  minutes: number
  /** Cycles they have been carried for: 1 in the cycle right after the one they came from. */
  age: number
}

type RolloverPolicy = {
  enabled: boolean
  /** Most minutes carried into a cycle, or null for no cap. */
  maxMinutes: number | null
  /** Most cycles a minute may be carried for, or null for no limit. */
  maxCycles: number | null
}

type CycleBalance = {
  /** Minutes the cycle had: its own plus what it was carried. */
  availableMinutes: number
  usedMinutes: number
  /** Used beyond what was available: what is charged. */
  overageMinutes: number
  /** Minutes left unused that the policy lets go: past their age or over the cap, or no rollover. */
  expiredMinutes: number
  /** What the next cycle starts with. */
  carried: CarriedBucket[]
}

const sum = (buckets: CarriedBucket[]) => buckets.reduce((total, bucket) => total + bucket.minutes, 0)

/**
 * Closes a cycle's books.
 *
 * Usage is drawn from the oldest minutes first — carried buckets by age, then the cycle's own — so
 * what is closest to expiring is what gets used. What is left either rolls over or expires: a bucket
 * that would exceed `maxCycles` expires, and if the survivors still exceed `maxMinutes`, the oldest
 * are trimmed first, because the newest have the most life left. Usage beyond everything available
 * is overage, charged in the next cycle.
 */
const closeCycle = (input: { startsOn: string; includedMinutes: number; carried: CarriedBucket[]; usedMinutes: number; policy: RolloverPolicy }): CycleBalance => {
  const buckets: CarriedBucket[] = [
    ...[...input.carried].sort((a, b) => b.age - a.age || a.from.localeCompare(b.from)).map((bucket) => ({ ...bucket })),
    { from: input.startsOn, minutes: input.includedMinutes, age: 0 },
  ]
  const availableMinutes = sum(buckets)
  let remaining = input.usedMinutes
  for (const bucket of buckets) {
    const take = Math.min(bucket.minutes, remaining)
    bucket.minutes -= take
    remaining -= take
  }
  const leftover = sum(buckets)
  if (!input.policy.enabled) {
    return { availableMinutes, usedMinutes: input.usedMinutes, overageMinutes: remaining, expiredMinutes: leftover, carried: [] }
  }

  let next = buckets
    .filter((bucket) => bucket.minutes > 0)
    .map((bucket) => ({ ...bucket, age: bucket.age + 1 }))
    .filter((bucket) => input.policy.maxCycles === null || bucket.age <= input.policy.maxCycles)
  if (input.policy.maxMinutes !== null) {
    // Newest first, so trimming eats the oldest.
    const kept: CarriedBucket[] = []
    let room = input.policy.maxMinutes
    for (const bucket of [...next].sort((a, b) => a.age - b.age)) {
      if (room <= 0) break
      const minutes = Math.min(bucket.minutes, room)
      kept.push({ ...bucket, minutes })
      room -= minutes
    }
    next = kept.sort((a, b) => b.age - a.age)
  }
  return { availableMinutes, usedMinutes: input.usedMinutes, overageMinutes: remaining, expiredMinutes: leftover - sum(next), carried: next }
}

/** Decimal places an amount is kept to: whole pesos, UF to the hundredth. */
const CURRENCY_DECIMALS: Record<Currency, number> = { CLP: 0, UF: 2 }

/** What `minutes` of overage cost at `ratePerHour`, rounded the way the currency is written. */
const overageAmount = (minutes: number, ratePerHour: number, currency: Currency) => {
  const factor = 10 ** CURRENCY_DECIMALS[currency]
  return Math.round((minutes / 60) * ratePerHour * factor) / factor
}

export { addDays, addMonths, closeCycle, cycleContaining, cycleOpeningOn, cycleStart, daysBetween, overageAmount, sum as carriedMinutes }
export type { CarriedBucket, CycleBalance, RolloverPolicy }
