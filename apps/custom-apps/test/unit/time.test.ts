import { describe, expect, it } from 'vitest'
import { daysBetween, previousDay, splitByHour, startOfZonedDay, zonedDay, zonedDayRange, zonedParts } from '@/lib/time'

describe('Santiago wall-clock arithmetic', () => {
  it('reads the day in Santiago, not in UTC', () => {
    // 02:30 UTC on the 15th is still the 14th in Santiago, at UTC-3 or UTC-4.
    expect(zonedDay(new Date('2026-10-15T02:30:00Z'))).toBe('2026-10-14')
    expect(zonedDay(new Date('2026-10-15T12:00:00Z'))).toBe('2026-10-15')
  })

  it('numbers weekdays from Monday', () => {
    // 2026-10-12 is a Monday; at 15:00 UTC it is Monday in Santiago too.
    expect(zonedParts(new Date('2026-10-12T15:00:00Z')).weekday).toBe(0)
    expect(zonedParts(new Date('2026-10-18T15:00:00Z')).weekday).toBe(6)
  })

  it('finds local midnight in summer time (UTC-3)', () => {
    expect(startOfZonedDay('2026-01-15').toISOString()).toBe('2026-01-15T03:00:00.000Z')
  })

  it('finds local midnight in winter time (UTC-4)', () => {
    expect(startOfZonedDay('2026-07-15').toISOString()).toBe('2026-07-15T04:00:00.000Z')
  })

  it('makes a day whose clocks change 23 or 25 hours long', () => {
    // Chile leaves summer time on the first Sunday of April and enters it on the first Sunday of
    // September; whichever day of each it lands on, the ranges have to tile with no gap.
    for (const day of ['2026-04-04', '2026-04-05', '2026-09-05', '2026-09-06']) {
      const { start, end } = zonedDayRange(day)
      const hours = (end.getTime() - start.getTime()) / 3_600_000
      expect([23, 24, 25]).toContain(hours)
      expect(zonedDayRange(previousDay(day)).end.getTime()).toBe(start.getTime())
    }
  })

  it('walks calendar days', () => {
    expect(previousDay('2026-03-01')).toBe('2026-02-28')
    expect(daysBetween('2026-12-30', '2027-01-02')).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'])
    expect(daysBetween('2026-01-02', '2026-01-01')).toEqual([])
  })
})

describe('splitting an interval by hour', () => {
  it('keeps an interval inside one hour whole', () => {
    expect(splitByHour(3600 * 10 + 100, 3600 * 10 + 160)).toEqual([[36_000, 60]])
  })

  it('files each piece of a straddling interval under its own hour', () => {
    expect(splitByHour(3600 * 10 + 3570, 3600 * 11 + 30)).toEqual([
      [36_000, 30],
      [39_600, 30],
    ])
  })

  it('is empty for an empty interval', () => {
    expect(splitByHour(100, 100)).toEqual([])
  })
})
