import { describe, expect, it } from 'vitest'
import {
  ALL_RELEASES,
  dayKey,
  dayRange,
  isProductWide,
  MAX_SERIES_DAYS,
  shiftDay,
  VIEW_DEDUP_WINDOW_SECONDS,
  viewToken,
} from '@/lib/analytics'

describe('dayKey', () => {
  it('buckets on the UTC day, never the viewer\'s', () => {
    expect(dayKey(new Date('2026-03-15T23:59:59.999Z'))).toBe('2026-03-15')
    expect(dayKey(new Date('2026-03-16T00:00:00.000Z'))).toBe('2026-03-16')
  })

  /**
   * A local-time bucket would make a day 23 or 25 hours long twice a year, and Chile changes its
   * clocks. UTC is the only definition under which "yesterday" is the same length as "today".
   */
  it('is unmoved by a daylight-saving change', () => {
    expect(dayKey(new Date('2026-09-06T03:30:00.000Z'))).toBe('2026-09-06')
    expect(dayKey(new Date('2026-04-04T04:30:00.000Z'))).toBe('2026-04-04')
  })
})

describe('dayRange', () => {
  it('covers both ends inclusively', () => {
    expect(dayRange('2026-03-14', '2026-03-16')).toEqual(['2026-03-14', '2026-03-15', '2026-03-16'])
  })

  it('answers a single day for a range of one', () => {
    expect(dayRange('2026-03-14', '2026-03-14')).toEqual(['2026-03-14'])
  })

  it('crosses a month and a year boundary', () => {
    expect(dayRange('2026-12-31', '2027-01-01')).toEqual(['2026-12-31', '2027-01-01'])
  })

  it('stops at the ceiling rather than building an unbounded list', () => {
    expect(dayRange('2020-01-01', '2030-01-01').length).toBeLessThanOrEqual(MAX_SERIES_DAYS + 1)
  })
})

describe('shiftDay', () => {
  it('walks back the requested number of days', () => {
    expect(shiftDay(new Date('2026-03-16T12:00:00Z'), -2)).toBe('2026-03-14')
  })
})

describe('ALL_RELEASES', () => {
  /**
   * The empty string rather than NULL, and not for style: SQLite treats NULLs as *distinct* inside
   * a unique index, so `ON CONFLICT (product_id, release_id, day) DO UPDATE` would never match the
   * product-wide row and every single event would insert a new one instead of incrementing.
   */
  it('is the empty string, and is only ever compared through its own predicate', () => {
    expect(ALL_RELEASES).toBe('')
    expect(isProductWide(ALL_RELEASES)).toBe(true)
    expect(isProductWide('release-1')).toBe(false)
  })
})

describe('viewToken', () => {
  const base = { productId: 'product-1', releaseId: '', ip: '203.0.113.7', userAgent: 'Firefox' }

  it('is stable for the same viewer inside one window', async () => {
    const now = new Date('2026-03-16T12:00:00Z')
    const first = await viewToken({ ...base, now })
    const second = await viewToken({ ...base, now: new Date(now.getTime() + 60_000) })

    expect(first).toBe(second)
  })

  /** Bucketed on `floor(now / window)`, so the token rolls over on its own and nothing expires it. */
  it('changes once the window has rolled over', async () => {
    const now = new Date('2026-03-16T12:00:00Z')
    const later = new Date(now.getTime() + (VIEW_DEDUP_WINDOW_SECONDS + 60) * 1000)

    expect(await viewToken({ ...base, now })).not.toBe(await viewToken({ ...base, now: later }))
  })

  it.each([
    ['a different product', { productId: 'product-2' }],
    ['a different release', { releaseId: 'release-9' }],
    ['a different address', { ip: '198.51.100.4' }],
    ['a different browser', { userAgent: 'Safari' }],
  ])('separates %s', async (_label, overrides) => {
    const now = new Date('2026-03-16T12:00:00Z')

    expect(await viewToken({ ...base, now })).not.toBe(await viewToken({ ...base, ...overrides, now }))
  })

  /** The address goes in and never comes out: a view counter is not a reason to keep one. */
  it('is a digest, not a record of who was there', async () => {
    const token = await viewToken({ ...base, now: new Date('2026-03-16T12:00:00Z') })

    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(token).not.toContain('203.0.113.7')
  })
})
