import { describe, expect, it } from 'vitest'
import { securityWindow, suggestWindows, withinOperatingHours, type Heatmap, type OperatingHours } from '@/lib/maintenance-windows'
import { zonedParts } from '@/lib/time'

/**
 * Window selection against synthetic heatmaps, on a fixed clock: Monday 2 November 2026, 12:00 UTC —
 * 09:00 in Santiago, which is on summer time (UTC−3) then. Nothing here reads the wall clock.
 */
const NOW = Date.parse('2026-11-02T12:00:00Z') / 1000
const HOUR = 3600

/** Every cell `fill`, then the overrides: `[weekday, hour, value]`, Monday = 0, Santiago hours. */
const heatmap = (fill: number, overrides: Array<[number, number, number]> = []): Heatmap => {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => fill))
  for (const [weekday, hour, value] of overrides) grid[weekday]![hour] = value
  return grid
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString()
const local = (seconds: number) => zonedParts(new Date(seconds * 1000))

describe('suggested windows', () => {
  it('start at least 24 hours ahead, on the hour, never overlap, and go to the earliest among equals', () => {
    const picked = suggestWindows({ heatmap: heatmap(100), operatingHours: null, now: NOW, estimatedMinutes: 120 })
    expect(picked).toHaveLength(5)
    expect(picked.map((candidate) => iso(candidate.start))).toEqual([
      '2026-11-03T12:00:00.000Z',
      '2026-11-03T14:00:00.000Z',
      '2026-11-03T16:00:00.000Z',
      '2026-11-03T18:00:00.000Z',
      '2026-11-03T20:00:00.000Z',
    ])
    for (const candidate of picked) {
      expect(candidate.start).toBeGreaterThanOrEqual(NOW + 24 * HOUR)
      expect(candidate.end - candidate.start).toBe(120 * 60)
      expect(candidate.score).toBe(200)
    }
  })

  it('go to the least used blocks of the next 14 days, scored on every hour they touch', () => {
    // Wednesday 02:00–04:00 nobody uses it; Friday 03:00–05:00 hardly anybody.
    const map = heatmap(100, [
      [2, 2, 0],
      [2, 3, 0],
      [4, 3, 5],
      [4, 4, 5],
    ])
    const picked = suggestWindows({ heatmap: map, operatingHours: null, now: NOW, estimatedMinutes: 90 })
    // Both Wednesdays within the horizon score 0, then both Fridays 10; the earlier of equals first.
    expect(picked.slice(0, 4).map((candidate) => [iso(candidate.start), candidate.score])).toEqual([
      ['2026-11-04T05:00:00.000Z', 0],
      ['2026-11-11T05:00:00.000Z', 0],
      ['2026-11-06T06:00:00.000Z', 10],
      ['2026-11-13T06:00:00.000Z', 10],
    ])
    expect(local(picked[0]!.start)).toMatchObject({ weekday: 2, hour: 2 })
    // A 90-minute block is scored on two hours, and ends 90 minutes in.
    expect(picked[0]!.end - picked[0]!.start).toBe(90 * 60)
    for (const candidate of picked) expect(candidate.end).toBeLessThanOrEqual(NOW + 14 * 86_400)
  })

  it('leave out the windows already offered and anything overlapping them', () => {
    const map = heatmap(100, [
      [2, 2, 0],
      [2, 3, 0],
    ])
    const offered = { start: Date.parse('2026-11-04T05:00:00Z') / 1000, end: Date.parse('2026-11-04T07:00:00Z') / 1000 }
    const picked = suggestWindows({ heatmap: map, operatingHours: null, now: NOW, estimatedMinutes: 120, existing: [offered] })
    expect(picked.map((candidate) => iso(candidate.start))).not.toContain('2026-11-04T05:00:00.000Z')
    for (const candidate of picked) expect(candidate.start >= offered.end || candidate.end <= offered.start).toBe(true)
    expect(iso(picked[0]!.start)).toBe('2026-11-11T05:00:00.000Z')
  })

  it('stay inside the operating hours, where the devices are on', () => {
    const hours: OperatingHours = {
      timezone: 'America/Santiago',
      days: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => [day, [{ start: '08:00', end: '20:00' }]])),
    }
    // The night is unused, but the kiosks are off then: the quietest open hour is Thursday 08:00.
    const map = heatmap(100, [
      [2, 2, 0],
      [3, 8, 1],
    ])
    const picked = suggestWindows({ heatmap: map, operatingHours: hours, now: NOW, estimatedMinutes: 60 })
    expect(iso(picked[0]!.start)).toBe('2026-11-05T11:00:00.000Z')
    for (const candidate of picked) {
      expect(local(candidate.start).hour).toBeGreaterThanOrEqual(8)
      expect(local(candidate.end - 1).hour).toBeLessThan(20)
    }
  })

  it('offer nothing when the operating hours leave no room for the duration', () => {
    const hours: OperatingHours = { days: { mon: [{ start: '10:00', end: '10:30' }] } }
    expect(suggestWindows({ heatmap: heatmap(0), operatingHours: hours, now: NOW, estimatedMinutes: 60 })).toEqual([])
  })
})

describe('operating hours', () => {
  const at = (value: string) => Date.parse(value) / 1000

  it('need every minute of a block inside a declared window', () => {
    const hours: OperatingHours = { days: { tue: [{ start: '08:00', end: '12:00' }, { start: '12:00', end: '18:00' }] } }
    // Tuesday 11:00–13:00 Santiago spans two touching windows, which count as one.
    expect(withinOperatingHours(hours, { start: at('2026-11-03T14:00:00Z'), end: at('2026-11-03T16:00:00Z') })).toBe(true)
    // 17:00–19:00 runs past the end.
    expect(withinOperatingHours(hours, { start: at('2026-11-03T20:00:00Z'), end: at('2026-11-03T22:00:00Z') })).toBe(false)
    expect(withinOperatingHours(null, { start: at('2026-11-03T03:00:00Z'), end: at('2026-11-03T05:00:00Z') })).toBe(true)
  })

  it('need both days for a block across midnight', () => {
    const late: OperatingHours = { days: { mon: [{ start: '22:00', end: '24:00' }] } }
    const both: OperatingHours = { days: { mon: [{ start: '22:00', end: '24:00' }], tue: [{ start: '00:00', end: '02:00' }] } }
    // Monday 23:00 → Tuesday 01:00 in Santiago.
    const block = { start: at('2026-11-03T02:00:00Z'), end: at('2026-11-03T04:00:00Z') }
    expect(withinOperatingHours(late, block)).toBe(false)
    expect(withinOperatingHours(both, block)).toBe(true)
  })

  it('are read in their own time zone', () => {
    // 09:00–17:00 in UTC is 06:00–14:00 in Santiago in November.
    const utc: OperatingHours = { timezone: 'UTC', days: { tue: [{ start: '09:00', end: '17:00' }] } }
    expect(withinOperatingHours(utc, { start: at('2026-11-03T09:00:00Z'), end: at('2026-11-03T10:00:00Z') })).toBe(true)
    expect(withinOperatingHours(utc, { start: at('2026-11-03T17:00:00Z'), end: at('2026-11-03T18:00:00Z') })).toBe(false)
  })
})

describe('a security patch’s window', () => {
  it('is the first block nobody used within the contract’s days, however close', () => {
    // Tuesday 20:00 and Wednesday 20:00 are both unused: the earlier wins.
    const map = heatmap(100, [
      [1, 20, 0],
      [2, 20, 0],
    ])
    const chosen = securityWindow({ heatmap: map, operatingHours: null, now: NOW, estimatedMinutes: 60, days: 3 })
    expect(chosen).toMatchObject({ start: Date.parse('2026-11-03T23:00:00Z') / 1000, score: 0 })
  })

  it('falls back to the least used block when none is unused, within the horizon only', () => {
    const map = heatmap(100, [
      [2, 3, 10],
      [1, 5, 20],
      // Saturday is quieter still, but five days out: past a three-day horizon.
      [5, 3, 1],
    ])
    const chosen = securityWindow({ heatmap: map, operatingHours: null, now: NOW, estimatedMinutes: 60, days: 3 })
    expect(chosen).toMatchObject({ start: Date.parse('2026-11-04T06:00:00Z') / 1000, score: 10 })
    const wider = securityWindow({ heatmap: map, operatingHours: null, now: NOW, estimatedMinutes: 60, days: 7 })
    expect(wider).toMatchObject({ start: Date.parse('2026-11-07T06:00:00Z') / 1000, score: 1 })
  })

  it('starts at least two hours from now', () => {
    const chosen = securityWindow({ heatmap: heatmap(0), operatingHours: null, now: NOW + 600, estimatedMinutes: 30, days: 1 })
    expect(iso(chosen!.start)).toBe('2026-11-02T15:00:00.000Z')
  })

  it('is null when nothing fits', () => {
    const hours: OperatingHours = { days: { mon: [{ start: '10:00', end: '10:30' }] } }
    expect(securityWindow({ heatmap: heatmap(0), operatingHours: hours, now: NOW, estimatedMinutes: 60, days: 3 })).toBeNull()
  })
})
