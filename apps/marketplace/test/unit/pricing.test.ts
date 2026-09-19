import { describe, expect, it } from 'vitest'
import {
  AMOUNT_LIMITS,
  describePricing,
  mustOfferPayment,
  parsePricingMode,
  purchaseKindFor,
  resolveChargeAmount,
} from '@/lib/pricing'

const product = (overrides: Partial<Parameters<typeof describePricing>[0]> = {}) => ({
  pricingMode: 'free',
  priceAmount: null,
  suggestedAmount: null,
  ...overrides,
})

describe('parsePricingMode', () => {
  it('reads the three known modes back', () => {
    expect(parsePricingMode('free')).toBe('free')
    expect(parsePricingMode('donation')).toBe('donation')
    expect(parsePricingMode('paid')).toBe('paid')
  })

  it('falls back to free on an unknown or missing mode', () => {
    // Falling back *open* would be the dangerous direction: `free` grants the least.
    expect(parsePricingMode('subscription')).toBe('free')
    expect(parsePricingMode(null)).toBe('free')
  })
})

describe('describePricing', () => {
  it('describes a free product as taking no money', () => {
    const pricing = describePricing(product())
    expect(pricing).toMatchObject({
      mode: 'free',
      accepts_payment: false,
      requires_payment: false,
      allows_skip: true,
      price: null,
      suggested_amount: null,
    })
  })

  it('describes a paid product as gated', () => {
    const pricing = describePricing(product({ pricingMode: 'paid', priceAmount: 4990 }))
    expect(pricing).toMatchObject({
      mode: 'paid',
      price: 4990,
      requires_payment: true,
      allows_skip: false,
      accepts_payment: true,
      currency: 'CLP',
    })
  })

  it('describes a donation as skippable', () => {
    const pricing = describePricing(product({ pricingMode: 'donation', suggestedAmount: 3000 }))
    expect(pricing).toMatchObject({
      mode: 'donation',
      suggested_amount: 3000,
      allows_skip: true,
      requires_payment: false,
      accepts_payment: true,
    })
  })

  it('hides a price left over from a mode the product is no longer in', () => {
    // An editor who switches a paid product to `donation` keeps the column, so nothing here may
    // quote it — otherwise the website prices something that is currently free to take.
    const pricing = describePricing(product({ pricingMode: 'donation', priceAmount: 4990, suggestedAmount: 1000 }))
    expect(pricing.price).toBeNull()

    const back = describePricing(product({ pricingMode: 'paid', priceAmount: 4990, suggestedAmount: 1000 }))
    expect(back.suggested_amount).toBeNull()
    expect(back.price).toBe(4990)
  })
})

describe('mustOfferPayment', () => {
  it('offers to every non-payer of a paying product', () => {
    for (const mode of ['paid', 'donation'] as const) {
      const pricing = describePricing(product({ pricingMode: mode, priceAmount: 1000, suggestedAmount: 1000 }))
      expect(mustOfferPayment(pricing, false)).toBe(true)
    }
  })

  it('never offers to somebody who has paid, and never for a free product', () => {
    const paid = describePricing(product({ pricingMode: 'paid', priceAmount: 1000 }))
    expect(mustOfferPayment(paid, true)).toBe(false)
    expect(mustOfferPayment(describePricing(product()), false)).toBe(false)
  })
})

describe('resolveChargeAmount', () => {
  it('refuses to charge for a free product', () => {
    expect(resolveChargeAmount(describePricing(product()), 5000)).toHaveProperty('error')
  })

  it('charges a paid product its price whatever was asked for', () => {
    const pricing = describePricing(product({ pricingMode: 'paid', priceAmount: 4990 }))
    // A client that can name its own price for a paid product has no price.
    expect(resolveChargeAmount(pricing, AMOUNT_LIMITS.min)).toEqual({ amount: 4990 })
    expect(resolveChargeAmount(pricing, undefined)).toEqual({ amount: 4990 })
  })

  it('refuses a paid product with no price set', () => {
    const pricing = describePricing(product({ pricingMode: 'paid' }))
    expect(resolveChargeAmount(pricing, undefined)).toHaveProperty('error')
  })

  it('lets a donor name their own amount, above or below the suggestion', () => {
    const pricing = describePricing(product({ pricingMode: 'donation', suggestedAmount: 5000 }))
    expect(resolveChargeAmount(pricing, 20_000)).toEqual({ amount: 20_000 })
    // The suggestion is a suggestion. Refusing less would make it a price with extra steps.
    expect(resolveChargeAmount(pricing, AMOUNT_LIMITS.min)).toEqual({ amount: AMOUNT_LIMITS.min })
  })

  it('falls back to the suggestion, then to the floor', () => {
    expect(resolveChargeAmount(describePricing(product({ pricingMode: 'donation', suggestedAmount: 7000 })), undefined)).toEqual({
      amount: 7000,
    })
    expect(resolveChargeAmount(describePricing(product({ pricingMode: 'donation' })), undefined)).toEqual({
      amount: AMOUNT_LIMITS.min,
    })
  })

  it('holds the floor and the ceiling', () => {
    const pricing = describePricing(product({ pricingMode: 'donation' }))
    expect(resolveChargeAmount(pricing, AMOUNT_LIMITS.min - 1)).toHaveProperty('error')
    expect(resolveChargeAmount(pricing, AMOUNT_LIMITS.max + 1)).toHaveProperty('error')
  })
})

describe('purchaseKindFor', () => {
  it('names a paid product a purchase and everything else a donation', () => {
    expect(purchaseKindFor('paid')).toBe('purchase')
    expect(purchaseKindFor('donation')).toBe('donation')
    expect(purchaseKindFor('free')).toBe('donation')
  })
})
