import { HTTPException } from 'hono/http-exception'
import { describe, expect, it } from 'vitest'
import { asConflict, isUniqueViolation } from '@/lib/errors'

/** Builds an error chain `depth` links long, with the D1 message on the deepest link. */
const nest = (depth: number, deepest: string) => {
  let error = new Error(deepest)
  for (let level = 0; level < depth; level++) {
    error = new Error(`wrapper ${level}`, { cause: error })
  }
  return error
}

const UNIQUE = 'D1_ERROR: UNIQUE constraint failed: content_entries.collection, content_entries.slug: SQLITE_CONSTRAINT'

describe('isUniqueViolation', () => {
  it('finds the message on the top-level error', () => {
    expect(isUniqueViolation(new Error(UNIQUE))).toBe(true)
  })

  it('finds it on a nested cause, which is where Drizzle actually puts it', () => {
    // The whole point of the helper: Drizzle wraps the driver error, so matching the top-level
    // message alone would never fire and a duplicate slug would 500 instead of 409.
    const wrapped = new Error('Failed query: insert into "content_entries" ...', {
      cause: new Error(UNIQUE),
    })
    expect(isUniqueViolation(wrapped)).toBe(true)
  })

  it('matches case-insensitively', () => {
    expect(isUniqueViolation(new Error('unique constraint failed: legal_pages.slug'))).toBe(true)
  })

  it('reaches the deepest link still inside the depth bound', () => {
    // 7 wrappers plus the cause itself is the 8th link, the last one the loop looks at.
    expect(isUniqueViolation(nest(7, UNIQUE))).toBe(true)
  })

  it('gives up past the depth bound of 8', () => {
    expect(isUniqueViolation(nest(8, UNIQUE))).toBe(false)
  })

  it('survives a self-referential cause without hanging', () => {
    const error: Error & { cause?: unknown } = new Error('recursive')
    error.cause = error
    expect(isUniqueViolation(error)).toBe(false)
  })

  it('survives a cycle that never reaches the message', () => {
    const first: Error & { cause?: unknown } = new Error('first')
    const second: Error & { cause?: unknown } = new Error('second')
    first.cause = second
    second.cause = first
    expect(isUniqueViolation(first)).toBe(false)
  })

  it('is false for an unrelated failure', () => {
    expect(isUniqueViolation(new Error('D1_ERROR: no such table: content_entries'))).toBe(false)
    expect(isUniqueViolation(new Error('NOT NULL constraint failed: content_entries.title'))).toBe(false)
  })

  it('is false for a non-Error throw', () => {
    expect(isUniqueViolation('UNIQUE constraint failed')).toBe(false)
    expect(isUniqueViolation({ message: 'UNIQUE constraint failed' })).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation(undefined)).toBe(false)
  })

  it('stops walking at a non-Error link in the middle of the chain', () => {
    const broken = new Error('outer', { cause: { cause: new Error(UNIQUE) } })
    expect(isUniqueViolation(broken)).toBe(false)
  })
})

describe('asConflict', () => {
  it('maps a unique violation to a 409 carrying the caller message', () => {
    const result = asConflict(new Error(UNIQUE), 'An entry with slug "x" already exists')

    expect(result).toBeInstanceOf(HTTPException)
    expect((result as HTTPException).status).toBe(409)
    expect(result.message).toBe('An entry with slug "x" already exists')
  })

  it('maps a nested unique violation too', () => {
    const result = asConflict(new Error('Failed query', { cause: new Error(UNIQUE) }), 'duplicate')
    expect((result as HTTPException).status).toBe(409)
  })

  it('re-raises an unrelated error untouched, same instance and all', () => {
    const original = new Error('D1_ERROR: database is locked')
    const result = asConflict(original, 'duplicate')

    expect(result).toBe(original)
    expect(result).not.toBeInstanceOf(HTTPException)
  })

  it('wraps a non-Error throw in an Error rather than returning it raw', () => {
    const result = asConflict('something went wrong', 'duplicate')

    expect(result).toBeInstanceOf(Error)
    expect(result.message).toBe('something went wrong')
  })

  it('wraps a thrown object using its string form', () => {
    expect(asConflict({ code: 500 }, 'duplicate').message).toBe('[object Object]')
    expect(asConflict(null, 'duplicate').message).toBe('null')
  })

  it('returns rather than throws, so the caller decides when to raise', () => {
    expect(() => asConflict(new Error(UNIQUE), 'duplicate')).not.toThrow()
  })
})
