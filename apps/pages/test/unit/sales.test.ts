import { describe, expect, it } from 'vitest'
import {
  describeWithdrawal,
  formatVoucherNumber,
  isLinkedToAccount,
  isManualSource,
  isRefundable,
  MANUAL_SALE_SOURCES,
  parsePaymentEnvironment,
  parseSaleSource,
  UNLINKED_USER_ID,
  voucherNumberPrefix,
  WITHDRAWAL_DAYS,
  withdrawalDeadline,
} from '@/lib/sales'

describe('sale sources', () => {
  it('never offers MercadoPago as something an editor can record by hand', () => {
    // A row claiming the provider took money it has no record of would be indistinguishable from a
    // real payment and grants the same access, so the manual set is every source *but* that one.
    expect(MANUAL_SALE_SOURCES).not.toContain('mercadopago')
    expect(MANUAL_SALE_SOURCES).toEqual(['cash', 'bank_transfer', 'gift', 'other'])
  })

  it('falls back to `other` rather than to the provider on an unknown stored value', () => {
    expect(parseSaleSource('cash')).toBe('cash')
    expect(parseSaleSource('bitcoin')).toBe('other')
    expect(parseSaleSource(null)).toBe('other')
  })

  it('treats everything except MercadoPago as settled by hand', () => {
    expect(isManualSource('mercadopago')).toBe(false)
    expect(isManualSource('cash')).toBe(true)
    expect(isManualSource('gift')).toBe(true)
  })
})

describe('payment environments', () => {
  /**
   * The direction of this fallback is the whole point: an unset or misspelled value has to read as
   * the side that cannot take real money, which is the opposite of how `parsePricingMode` falls back
   * and for the same reason — each one falls towards granting the least.
   */
  it('falls back to sandbox on anything it does not recognise', () => {
    expect(parsePaymentEnvironment('live')).toBe('live')
    expect(parsePaymentEnvironment('sandbox')).toBe('sandbox')
    expect(parsePaymentEnvironment('production')).toBe('sandbox')
    expect(parsePaymentEnvironment(undefined)).toBe('sandbox')
  })
})

describe('the withdrawal window', () => {
  const approved = new Date('2026-09-01T12:00:00Z')

  it('runs ten days from the approval, per ley 19.496', () => {
    expect(WITHDRAWAL_DAYS).toBe(10)
    expect(withdrawalDeadline(approved)?.toISOString()).toBe('2026-09-11T12:00:00.000Z')
  })

  it('does not exist for a sale nobody paid', () => {
    expect(withdrawalDeadline(null)).toBeNull()
    expect(describeWithdrawal(null)).toEqual({ deadline: null, days_left: null, within_period: false })
  })

  /**
   * Rounded up, so the last partial day reads as one day rather than zero. An editor told "0 days
   * left" about a right that expires in four hours would refuse a refund they are obliged to give.
   */
  it('rounds a partial day up and stays inside the period', () => {
    const almostOver = describeWithdrawal(approved, new Date('2026-09-11T08:00:00Z'))
    expect(almostOver.days_left).toBe(1)
    expect(almostOver.within_period).toBe(true)
  })

  it('closes exactly on the deadline and never reports a negative day', () => {
    expect(describeWithdrawal(approved, new Date('2026-09-11T12:00:00Z')).within_period).toBe(false)
    expect(describeWithdrawal(approved, new Date('2026-10-01T00:00:00Z')).days_left).toBe(0)
  })
})

describe('voucher numbers', () => {
  it('zero-pads the sequence to six digits under its year', () => {
    expect(formatVoucherNumber(2026, 42)).toBe('FS-2026-000042')
    expect(voucherNumberPrefix(2026)).toBe('FS-2026-')
  })

  it('numbers a sequence that the prefix can be counted by', () => {
    expect(formatVoucherNumber(2026, 1).startsWith(voucherNumberPrefix(2026))).toBe(true)
  })
})

describe('refundability', () => {
  /**
   * Only an approved sale. A pending one took no money to give back, a rejected one never took any,
   * and a charged-back one has already had it taken — refunding that last case is how an account
   * pays twice for one dispute.
   */
  it('accepts only an approved sale', () => {
    expect(isRefundable('approved')).toBe(true)
    for (const status of ['pending', 'in_process', 'rejected', 'cancelled', 'refunded', 'charged_back'] as const) {
      expect(isRefundable(status)).toBe(false)
    }
  })
})

describe('the unlinked sentinel', () => {
  it('reads a real account as linked and the sentinel as not', () => {
    expect(isLinkedToAccount('buyer-1')).toBe(true)
    expect(isLinkedToAccount(UNLINKED_USER_ID)).toBe(false)
    expect(isLinkedToAccount(null)).toBe(false)
  })
})
