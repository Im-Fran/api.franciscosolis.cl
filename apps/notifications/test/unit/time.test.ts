import { describe, expect, it } from 'vitest'
import { dueDigests, localClock } from '@/lib/time'

describe('the digest clock', () => {
  it('fires at 09:00 Santiago in summer, when Chile is UTC-3', () => {
    // Wednesday 14 January 2026, 12:00 UTC = 09:00 CLST.
    expect(localClock(new Date('2026-01-14T12:00:00Z'))).toEqual({ hour: 9, weekday: 'Wed' })
    expect(dueDigests(new Date('2026-01-14T12:00:00Z'))).toEqual(['daily'])
    expect(dueDigests(new Date('2026-01-14T13:00:00Z'))).toEqual([])
  })

  it('fires at 09:00 Santiago in winter, when Chile is UTC-4', () => {
    // Wednesday 15 July 2026, 13:00 UTC = 09:00 CLT. A fixed UTC cron would have been an hour off.
    expect(dueDigests(new Date('2026-07-15T13:00:00Z'))).toEqual(['daily'])
    expect(dueDigests(new Date('2026-07-15T12:00:00Z'))).toEqual([])
  })

  it('adds the weekly digest on Monday', () => {
    // Monday 13 July 2026, 09:00 CLT.
    expect(dueDigests(new Date('2026-07-13T13:00:00Z'))).toEqual(['daily', 'weekly'])
  })

  it('does nothing at any other hour', () => {
    const due = Array.from({ length: 24 }, (_, hour) =>
      dueDigests(new Date(Date.UTC(2026, 6, 13, hour))).length > 0 ? hour : null,
    ).filter((hour) => hour !== null)
    expect(due).toEqual([13])
  })
})
