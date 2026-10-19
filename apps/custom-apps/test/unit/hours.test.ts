import { describe, expect, it } from 'vitest'
import { addDays, addMonths, closeCycle, cycleContaining, cycleOpeningOn, daysBetween, overageAmount } from '@/lib/hours'

describe('calendar arithmetic', () => {
  it('moves days and months, clamping to the end of a short month from the anchor', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(daysBetween('2026-01-01', '2026-03-01')).toBe(59)
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    // Always from the anchor: March comes back to the 31st.
    expect(addMonths('2026-01-31', 2)).toBe('2026-03-31')
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29')
  })

  it('finds the cycle containing a day, for every period', () => {
    expect(cycleContaining('daily', '2026-10-01', '2026-10-17')).toEqual({ startsOn: '2026-10-17', endsOn: '2026-10-18' })
    expect(cycleContaining('weekly', '2026-10-01', '2026-10-17')).toEqual({ startsOn: '2026-10-15', endsOn: '2026-10-22' })
    expect(cycleContaining('monthly', '2026-01-31', '2026-02-28')).toEqual({ startsOn: '2026-02-28', endsOn: '2026-03-31' })
    expect(cycleContaining('monthly', '2026-01-31', '2026-02-27')).toEqual({ startsOn: '2026-01-31', endsOn: '2026-02-28' })
    expect(cycleContaining('monthly', '2026-01-15', '2026-03-14')).toEqual({ startsOn: '2026-02-15', endsOn: '2026-03-15' })
  })

  it('cuts the last cycle short at the end of the contract, and has none outside it', () => {
    expect(cycleContaining('monthly', '2026-01-15', '2026-03-20', '2026-03-31')).toEqual({ startsOn: '2026-03-15', endsOn: '2026-04-01' })
    expect(cycleContaining('monthly', '2026-01-15', '2026-01-14')).toBeNull()
    expect(cycleContaining('monthly', '2026-01-15', '2026-04-01', '2026-03-31')).toBeNull()
  })
})

describe('the cycle opening on a day', () => {
  it('is the whole period, with every included minute, when the day is a boundary', () => {
    expect(cycleOpeningOn('weekly', '2026-10-01', '2026-10-08', 600)).toEqual({ startsOn: '2026-10-08', endsOn: '2026-10-15', includedMinutes: 600 })
    expect(cycleOpeningOn('monthly', '2026-01-31', '2026-02-28', 600)).toEqual({ startsOn: '2026-02-28', endsOn: '2026-03-31', includedMinutes: 600 })
    expect(cycleOpeningOn('monthly', '2026-01-15', '2026-01-15', 600)).toEqual({ startsOn: '2026-01-15', endsOn: '2026-02-15', includedMinutes: 600 })
  })

  it('runs to the next boundary from mid-period, with the minutes prorated by days', () => {
    // A renewal after a contract ended mid-week: 4 of 7 days, 600 × 4/7 = 342.86.
    expect(cycleOpeningOn('weekly', '2026-10-01', '2026-10-11', 600)).toEqual({ startsOn: '2026-10-11', endsOn: '2026-10-15', includedMinutes: 343 })
    // Rounded to the nearest whole minute, both ways: 100 × 4/7 = 57.14, 100 × 3/7 = 42.86.
    expect(cycleOpeningOn('weekly', '2026-10-01', '2026-10-11', 100)?.includedMinutes).toBe(57)
    expect(cycleOpeningOn('weekly', '2026-10-01', '2026-10-12', 100)?.includedMinutes).toBe(43)
    // 26 of March 15 – April 15's 31 days: 600 × 26/31 = 503.23.
    expect(cycleOpeningOn('monthly', '2026-01-15', '2026-03-20', 600)).toEqual({ startsOn: '2026-03-20', endsOn: '2026-04-15', includedMinutes: 503 })
    // A short month is its own period: 10 of February's 28 days from an anchor on the 1st.
    expect(cycleOpeningOn('monthly', '2026-01-01', '2026-02-19', 280)).toEqual({ startsOn: '2026-02-19', endsOn: '2026-03-01', includedMinutes: 100 })
    expect(cycleOpeningOn('weekly', '2026-10-01', '2026-10-11', 0)?.includedMinutes).toBe(0)
  })

  it('is still cut at the end of the contract, prorated against the full period', () => {
    // 2 of 7 days: opened mid-week and the contract ends the day after.
    expect(cycleOpeningOn('weekly', '2026-10-01', '2026-10-11', 700, '2026-10-12')).toEqual({ startsOn: '2026-10-11', endsOn: '2026-10-13', includedMinutes: 200 })
    // A boundary cut short keeps the whole period's minutes, as the first cycle of a short contract always has.
    expect(cycleOpeningOn('weekly', '2026-10-01', '2026-10-08', 700, '2026-10-09')).toEqual({ startsOn: '2026-10-08', endsOn: '2026-10-10', includedMinutes: 700 })
    expect(cycleOpeningOn('weekly', '2026-10-01', '2026-10-13', 700, '2026-10-12')).toBeNull()
    expect(cycleOpeningOn('weekly', '2026-10-01', '2026-09-30', 700)).toBeNull()
  })
})

describe('closing a cycle', () => {
  const policy = { enabled: true, maxMinutes: null, maxCycles: null }

  it('charges what was used beyond what was available', () => {
    const balance = closeCycle({ startsOn: '2026-10-01', includedMinutes: 600, carried: [], usedMinutes: 750, policy: { ...policy, enabled: false } })
    expect(balance).toEqual({ availableMinutes: 600, usedMinutes: 750, overageMinutes: 150, expiredMinutes: 0, carried: [] })
  })

  it('lets unused minutes expire without rollover', () => {
    const balance = closeCycle({ startsOn: '2026-10-01', includedMinutes: 600, carried: [], usedMinutes: 100, policy: { ...policy, enabled: false } })
    expect(balance).toMatchObject({ overageMinutes: 0, expiredMinutes: 500, carried: [] })
  })

  it('uses the oldest carried minutes first and carries the rest, aged by one', () => {
    const balance = closeCycle({
      startsOn: '2026-10-01',
      includedMinutes: 600,
      carried: [
        { from: '2026-09-01', minutes: 120, age: 1 },
        { from: '2026-08-01', minutes: 60, age: 2 },
      ],
      usedMinutes: 100,
      policy,
    })
    // 60 from August, then 40 from September.
    expect(balance.availableMinutes).toBe(780)
    expect(balance.carried).toEqual([
      { from: '2026-09-01', minutes: 80, age: 2 },
      { from: '2026-10-01', minutes: 600, age: 1 },
    ])
    expect(balance.expiredMinutes).toBe(0)
  })

  it('expires minutes past their age and trims the oldest over the cap', () => {
    const aged = closeCycle({
      startsOn: '2026-10-01',
      includedMinutes: 600,
      carried: [{ from: '2026-09-01', minutes: 120, age: 1 }],
      usedMinutes: 0,
      policy: { enabled: true, maxMinutes: null, maxCycles: 1 },
    })
    expect(aged.carried).toEqual([{ from: '2026-10-01', minutes: 600, age: 1 }])
    expect(aged.expiredMinutes).toBe(120)

    const capped = closeCycle({
      startsOn: '2026-10-01',
      includedMinutes: 600,
      carried: [{ from: '2026-09-01', minutes: 120, age: 1 }],
      usedMinutes: 0,
      policy: { enabled: true, maxMinutes: 650, maxCycles: null },
    })
    expect(capped.carried).toEqual([
      { from: '2026-09-01', minutes: 50, age: 2 },
      { from: '2026-10-01', minutes: 600, age: 1 },
    ])
    expect(capped.expiredMinutes).toBe(70)
  })

  it('prices overage the way the currency is written', () => {
    expect(overageAmount(90, 25_000, 'CLP')).toBe(37_500)
    expect(overageAmount(20, 1, 'CLP')).toBe(0)
    expect(overageAmount(50, 1.5, 'UF')).toBe(1.25)
  })
})
