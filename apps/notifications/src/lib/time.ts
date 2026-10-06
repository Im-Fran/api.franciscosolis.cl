import { DIGEST } from '@/lib/config'

/**
 * Wall-clock hour and weekday in the digest's time zone.
 *
 * `Intl` does the time-zone arithmetic, including Chile's daylight-saving changes, which is the
 * whole reason the cron is hourly rather than a fixed UTC hour. `hourCycle: 'h23'` because the
 * default for some locales renders midnight as `24`.
 */
const localClock = (date: Date, timeZone: string = DIGEST.timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(date)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? Number.NaN)
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? ''
  return { hour, weekday }
}

/**
 * Which digests are due at `now`: the daily one at the digest hour, and the weekly one too when that
 * hour falls on the weekly day. Empty at every other hour, which is what makes an hourly cron cheap.
 */
const dueDigests = (now: Date): Array<'daily' | 'weekly'> => {
  const { hour, weekday } = localClock(now)
  if (hour !== DIGEST.hour) {
    return []
  }
  return weekday === DIGEST.weeklyDay ? ['daily', 'weekly'] : ['daily']
}

export { dueDigests, localClock }
