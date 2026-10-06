import { describe, expect, it } from 'vitest'
import { daysBetween, isIsoDate, parseIsoDate, santiagoToday, shiftDays } from '@/indicators/dates'

describe('santiagoToday', () => {
  it("keeps Santiago's date when UTC has already moved on (summer time, UTC-3)", () => {
    // 23:00 on 6 October in Santiago.
    expect(santiagoToday(new Date('2026-10-07T02:00:00Z'))).toBe('2026-10-06')
  })

  it("keeps Santiago's date when UTC has already moved on (winter time, UTC-4)", () => {
    // 23:30 on 30 June in Santiago.
    expect(santiagoToday(new Date('2026-07-01T03:30:00Z'))).toBe('2026-06-30')
  })

  it('rolls over at midnight in Santiago, not at midnight UTC', () => {
    expect(santiagoToday(new Date('2026-10-07T03:00:00Z'))).toBe('2026-10-07')
  })

  it('pads month and day so the value sorts and parses as YYYY-MM-DD', () => {
    expect(santiagoToday(new Date('2026-01-05T15:00:00Z'))).toBe('2026-01-05')
  })
})

describe('isIsoDate / parseIsoDate', () => {
  it.each(['2026-10-06', '2024-02-29', '1977-08-01'])('accepts %s', (value) => {
    expect(isIsoDate(value)).toBe(true)
  })

  it.each([
    ['a day that does not exist', '2026-02-30'],
    ['a leap day outside a leap year', '2026-02-29'],
    ['month 13', '2026-13-01'],
    ["the bank's own DD-MM-YYYY format", '06-10-2026'],
    ['a timestamp', '2026-10-06T00:00:00Z'],
    ['an unpadded date', '2026-1-6'],
    ['an empty string', ''],
  ])('refuses %s', (_, value) => {
    expect(isIsoDate(value)).toBe(false)
    expect(parseIsoDate(value)).toBeNull()
  })
})

describe('shiftDays', () => {
  it('crosses month and year boundaries', () => {
    expect(shiftDays('2026-01-10', -15)).toBe('2025-12-26')
    expect(shiftDays('2026-02-27', 2)).toBe('2026-03-01')
  })

  it('counts the leap day', () => {
    expect(shiftDays('2024-03-01', -1)).toBe('2024-02-29')
  })
})

describe('daysBetween', () => {
  it('counts whole days, signed', () => {
    expect(daysBetween('2026-09-06', '2026-10-06')).toBe(30)
    expect(daysBetween('2026-10-06', '2026-10-06')).toBe(0)
    expect(daysBetween('2026-10-06', '2026-10-05')).toBe(-1)
  })

  it('is not thrown off by a daylight-saving change in Chile', () => {
    // Chile moved its clocks on 6 September 2026; the arithmetic is on UTC days, so it does not care.
    expect(daysBetween('2026-09-01', '2026-09-30')).toBe(29)
  })
})
