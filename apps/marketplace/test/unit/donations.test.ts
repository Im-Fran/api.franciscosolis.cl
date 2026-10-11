import { describe, expect, it } from 'vitest'
import {
  DONATE_PATH,
  DONATION_CURRENCIES,
  fromMinorUnits,
  GENERAL_FUND,
  isGeneralFund,
  sitePathFor,
  toMinorUnits,
  toSettlementAmount,
} from '@/lib/donations'
import { describePledge } from '@/services/purchases'

describe('toMinorUnits', () => {
  it('turns an amount into an integer of the currency\'s smallest unit', () => {
    expect(toMinorUnits(10.5, 'USD')).toBe(1050)
    expect(toMinorUnits(5000, 'CLP')).toBe(5000)
    expect(toMinorUnits(1500, 'JPY')).toBe(1500)
  })

  it('survives the binary floating point a decimal amount arrives in', () => {
    // `10.1 * 100` is 1009.9999999999999; a donor typed 10.10, not 10.099…
    expect(toMinorUnits(10.1, 'USD')).toBe(1010)
    expect(toMinorUnits(0.29, 'EUR')).toBe(29)
  })

  it('refuses more decimals than the currency is written with', () => {
    expect(toMinorUnits(10.5, 'CLP')).toBeNull()
    expect(toMinorUnits(1.005, 'USD')).toBeNull()
    expect(toMinorUnits(99.9, 'JPY')).toBeNull()
  })

  it('takes amounts nobody would call a minimum or a maximum', () => {
    expect(toMinorUnits(0.01, 'USD')).toBe(1)
    expect(toMinorUnits(1, 'CLP')).toBe(1)
    expect(toMinorUnits(250_000_000, 'CLP')).toBe(250_000_000)
  })
})

describe('fromMinorUnits', () => {
  it('reads an integer of minor units back in the major unit', () => {
    expect(fromMinorUnits(1050, 'USD')).toBe(10.5)
    expect(fromMinorUnits(5000, 'CLP')).toBe(5000)
  })

  it('reads an unknown currency as having no minor unit rather than inventing cents', () => {
    expect(fromMinorUnits(1050, 'XYZ')).toBe(1050)
  })
})

describe('toSettlementAmount', () => {
  it('converts to whole pesos, rounding to the nearest one', () => {
    expect(toSettlementAmount(1000, 'USD', 977.54)).toBe(9775)
    expect(toSettlementAmount(1050, 'USD', 977.54)).toBe(10_264)
  })

  it('leaves pesos alone', () => {
    expect(toSettlementAmount(5000, 'CLP', 1)).toBe(5000)
  })

  it('answers null for something that rounds to no peso at all', () => {
    // One euro cent is about ten pesos; one yen is about six; a hundredth of an Argentine peso is not one.
    expect(toSettlementAmount(1, 'ARS', 0.64)).toBeNull()
  })
})

describe('the general fund', () => {
  it('is not the empty string, which every filter here reads as "no filter"', () => {
    expect(GENERAL_FUND.id).not.toBe('')
    expect(isGeneralFund(GENERAL_FUND.id)).toBe(true)
    expect(isGeneralFund('')).toBe(false)
    expect(isGeneralFund(crypto.randomUUID())).toBe(false)
  })

  it('lives at the donation page, and a product at its own', () => {
    expect(sitePathFor(GENERAL_FUND.id, GENERAL_FUND.slug)).toBe(DONATE_PATH)
    expect(sitePathFor(crypto.randomUUID(), 'openbattery')).toBe('/product/openbattery')
  })

  it('accepts pesos, the currency it settles in', () => {
    expect(DONATION_CURRENCIES.CLP.minor_units).toBe(0)
  })
})

describe('describePledge', () => {
  it('reads a pledge back in the major unit', () => {
    expect(describePledge({ pledgedAmount: 1050, pledgedCurrency: 'USD' })).toEqual({ amount: 10.5, currency: 'USD' })
  })

  it('reads the string literal a not-yet-migrated column answers as no pledge at all', () => {
    // Before the migration lands, SQLite answers a double-quoted unknown column with its own name.
    const garbage = { pledgedAmount: 'pledged_amount', pledgedCurrency: 'pledged_currency' } as unknown as {
      pledgedAmount: number | null
      pledgedCurrency: string | null
    }
    expect(describePledge(garbage)).toBeNull()
    expect(describePledge({ pledgedAmount: null, pledgedCurrency: null })).toBeNull()
  })
})
