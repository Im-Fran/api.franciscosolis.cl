import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { PAGINATION } from '@/lib/config'
import {
  dateInput,
  optionalDate,
  optionalText,
  optionalUrl,
  paginationSchema,
  requiredText,
  tagList,
  trimmedText,
} from '@/lib/validation'

describe('dateInput', () => {
  it('parses a full ISO 8601 datetime', () => {
    expect(v.parse(dateInput, '2026-08-16T12:30:00.000Z').toISOString()).toBe('2026-08-16T12:30:00.000Z')
  })

  it('parses a date-only string as UTC midnight', () => {
    expect(v.parse(dateInput, '2026-08-16').toISOString()).toBe('2026-08-16T00:00:00.000Z')
  })

  it('rejects garbage rather than yielding an Invalid Date', () => {
    expect(() => v.parse(dateInput, 'not a date')).toThrow(v.ValiError)
    expect(() => v.parse(dateInput, '')).toThrow(v.ValiError)
    expect(() => v.parse(dateInput, '2026-13-45')).toThrow(v.ValiError)
  })

  it('rejects a non-string, including a number of milliseconds', () => {
    expect(() => v.parse(dateInput, 1_755_000_000_000)).toThrow(v.ValiError)
    expect(() => v.parse(dateInput, new Date())).toThrow(v.ValiError)
    expect(() => v.parse(dateInput, null)).toThrow(v.ValiError)
  })

  it('carries the message the API surfaces on a bad date', () => {
    try {
      v.parse(dateInput, 'nope')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as v.ValiError<typeof dateInput>).issues[0]?.message).toBe('must be an ISO 8601 date')
    }
  })
})

describe('optionalDate', () => {
  it('distinguishes absent from an explicit null', () => {
    // The PATCH contract of the whole Worker: `undefined` means leave alone, `null` means clear.
    expect(v.parse(optionalDate, undefined)).toBeUndefined()
    expect(v.parse(optionalDate, null)).toBeNull()
  })

  it('still parses a real date', () => {
    expect(v.parse(optionalDate, '2026-01-01')).toBeInstanceOf(Date)
  })

  it('still rejects garbage', () => {
    expect(() => v.parse(optionalDate, 'nope')).toThrow(v.ValiError)
  })
})

describe('trimmedText / requiredText / optionalText', () => {
  it('trims surrounding whitespace', () => {
    expect(v.parse(trimmedText(10), '  hi  ')).toBe('hi')
  })

  it('lets trimmedText accept an empty string but not requiredText', () => {
    expect(v.parse(trimmedText(10), '   ')).toBe('')
    expect(() => v.parse(requiredText(10), '   ')).toThrow(v.ValiError)
  })

  it('enforces the maximum length after trimming', () => {
    expect(v.parse(trimmedText(3), ' abc ')).toBe('abc')
    expect(() => v.parse(trimmedText(3), 'abcd')).toThrow(v.ValiError)
  })

  it('gives optionalText both the undefined and the null case', () => {
    expect(v.parse(optionalText(10), undefined)).toBeUndefined()
    expect(v.parse(optionalText(10), null)).toBeNull()
    expect(v.parse(optionalText(10), ' text ')).toBe('text')
  })

  it('does not let optionalText past its bound', () => {
    expect(() => v.parse(optionalText(3), 'abcd')).toThrow(v.ValiError)
  })
})

describe('optionalUrl', () => {
  it('accepts an absolute URL and trims it', () => {
    expect(v.parse(optionalUrl, '  https://example.com/a  ')).toBe('https://example.com/a')
  })

  it('accepts undefined and null', () => {
    expect(v.parse(optionalUrl, undefined)).toBeUndefined()
    expect(v.parse(optionalUrl, null)).toBeNull()
  })

  it('rejects a scheme-less or empty URL', () => {
    expect(() => v.parse(optionalUrl, 'example.com')).toThrow(v.ValiError)
    expect(() => v.parse(optionalUrl, '')).toThrow(v.ValiError)
    expect(() => v.parse(optionalUrl, '/relative/path')).toThrow(v.ValiError)
  })

  it('rejects a URL past 2048 characters', () => {
    expect(() => v.parse(optionalUrl, `https://example.com/${'x'.repeat(2048)}`)).toThrow(v.ValiError)
  })
})

describe('tagList', () => {
  it('lowercases every tag so filtering does not care about casing', () => {
    expect(v.parse(tagList, ['TypeScript', 'CLOUDFLARE'])).toEqual(['typescript', 'cloudflare'])
  })

  it('trims before it lowercases', () => {
    expect(v.parse(tagList, ['  Go  '])).toEqual(['go'])
  })

  it('rejects a tag that is empty once trimmed', () => {
    expect(() => v.parse(tagList, ['   '])).toThrow(v.ValiError)
    expect(() => v.parse(tagList, [''])).toThrow(v.ValiError)
  })

  it('rejects a tag past 60 characters', () => {
    expect(v.parse(tagList, ['x'.repeat(60)])).toEqual(['x'.repeat(60)])
    expect(() => v.parse(tagList, ['x'.repeat(61)])).toThrow(v.ValiError)
  })

  it('accepts an empty list and undefined, but not null', () => {
    expect(v.parse(tagList, [])).toEqual([])
    expect(v.parse(tagList, undefined)).toBeUndefined()
    expect(() => v.parse(tagList, null)).toThrow(v.ValiError)
  })

  it('rejects a non-string tag', () => {
    expect(() => v.parse(tagList, [1])).toThrow(v.ValiError)
  })
})

describe('paginationSchema', () => {
  it('turns the query strings into numbers', () => {
    expect(v.parse(paginationSchema, { limit: '25', offset: '10' })).toEqual({ limit: 25, offset: 10 })
  })

  it('leaves both out when they are absent, so the route can default them', () => {
    expect(v.parse(paginationSchema, {})).toEqual({})
  })

  it('rejects a non-numeric limit or offset', () => {
    expect(() => v.parse(paginationSchema, { limit: 'abc' })).toThrow(v.ValiError)
    expect(() => v.parse(paginationSchema, { offset: '-1' })).toThrow(v.ValiError)
    expect(() => v.parse(paginationSchema, { limit: '1.5' })).toThrow(v.ValiError)
    expect(() => v.parse(paginationSchema, { limit: '' })).toThrow(v.ValiError)
  })

  it('holds limit to at most 3 digits and offset to at most 6', () => {
    expect(() => v.parse(paginationSchema, { limit: '1000' })).toThrow(v.ValiError)
    expect(v.parse(paginationSchema, { offset: '999999' })).toEqual({ offset: 999_999 })
    expect(() => v.parse(paginationSchema, { offset: '1000000' })).toThrow(v.ValiError)
  })

  it('accepts a limit exactly at the maximum and refuses one above it', () => {
    // The bound is a rejection, not a silent clamp: `maxValue` fails the parse, so an over-large
    // limit reaches the client as a 400 rather than being trimmed to 200.
    expect(v.parse(paginationSchema, { limit: String(PAGINATION.maxLimit) })).toEqual({
      limit: PAGINATION.maxLimit,
    })
    expect(() => v.parse(paginationSchema, { limit: String(PAGINATION.maxLimit + 1) })).toThrow(v.ValiError)
  })

  it('accepts a zero limit, which asks for nothing at all', () => {
    expect(v.parse(paginationSchema, { limit: '0', offset: '0' })).toEqual({ limit: 0, offset: 0 })
  })

  it('rejects a limit or offset sent as a number instead of a query string', () => {
    expect(() => v.parse(paginationSchema, { limit: 25 })).toThrow(v.ValiError)
  })
})
