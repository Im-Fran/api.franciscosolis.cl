import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import {
  emptyDistribution,
  parseReviewStatus,
  RATING_BOUNDS,
  RATING_VALUES,
  replySchema,
  REPORT_REASONS,
  reportSchema,
  REVIEW_LIMITS,
  reviewSchema,
} from '@/lib/reviews'

const review = (input: unknown) => v.safeParse(reviewSchema, input)

describe('reviewSchema', () => {
  it.each(RATING_VALUES)('accepts %i stars', (rating) => {
    expect(review({ rating }).success).toBe(true)
  })

  it.each([0, 6, -1, 2.5])('refuses %s as a rating', (rating) => {
    expect(review({ rating }).success).toBe(false)
  })

  it('bounds the prose rather than letting a review be a novel', () => {
    expect(review({ rating: 5, body: 'a'.repeat(REVIEW_LIMITS.body) }).success).toBe(true)
    expect(review({ rating: 5, body: 'a'.repeat(REVIEW_LIMITS.body + 1) }).success).toBe(false)
  })

  /** Strict, like every other write schema here: a misspelled field is a 422, not a lost sentence. */
  it('refuses a misspelled field', () => {
    expect(review({ rating: 5, tittle: 'Oops' }).success).toBe(false)
  })

  it('takes a rating on its own — a star with no words is still a review', () => {
    expect(review({ rating: 3 }).success).toBe(true)
  })
})

describe('replySchema', () => {
  it('refuses an empty answer', () => {
    expect(v.safeParse(replySchema, { body: '   ' }).success).toBe(false)
  })

  /** Shorter than a review on purpose: a reply is a reply, not a rebuttal. */
  it('is bounded below a review', () => {
    expect(REVIEW_LIMITS.reply).toBeLessThan(REVIEW_LIMITS.body)
  })
})

describe('reportSchema', () => {
  it.each(REPORT_REASONS)('accepts %s as a reason', (reason) => {
    expect(v.safeParse(reportSchema, { reason }).success).toBe(true)
  })

  it('refuses a reason outside the closed set, so the queue stays groupable', () => {
    expect(v.safeParse(reportSchema, { reason: 'i just dont like it' }).success).toBe(false)
  })
})

describe('parseReviewStatus', () => {
  it.each([
    ['null', null],
    ['an empty string', ''],
    ['a retired status', 'quarantined'],
  ])('falls back to visible for %s', (_label, raw) => {
    expect(parseReviewStatus(raw)).toBe('visible')
  })

  it('reads back the two states it knows', () => {
    expect(parseReviewStatus('visible')).toBe('visible')
    expect(parseReviewStatus('hidden')).toBe('hidden')
  })
})

describe('emptyDistribution', () => {
  /** Always all five keys, so a histogram is never sparse and a bar chart never shifts. */
  it('carries every star at zero', () => {
    expect(emptyDistribution()).toEqual({ '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 })
    expect(Object.keys(emptyDistribution())).toHaveLength(RATING_BOUNDS.max - RATING_BOUNDS.min + 1)
  })
})
