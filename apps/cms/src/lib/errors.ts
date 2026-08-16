import { HTTPException } from 'hono/http-exception'

/**
 * Drizzle wraps a failed statement in its own error and puts the driver's error underneath as
 * `cause`, so the D1 message that actually names the violated constraint is one or more links down
 * the chain — matching on the top-level message alone silently never fires.
 */
const errorChain = function* (error: unknown): Generator<Error> {
  let current: unknown = error
  // Bounded so a self-referential `cause` cannot spin forever.
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    yield current
    current = current.cause
  }
}

/** True when the error chain reports a violated UNIQUE index. */
const isUniqueViolation = (error: unknown): boolean => {
  for (const link of errorChain(error)) {
    if (/UNIQUE constraint failed/i.test(link.message)) {
      return true
    }
  }
  return false
}

/**
 * Maps a write failure to a 409 when it was caused by a unique index, and re-raises anything else
 * untouched. Slug uniqueness is the only unique index the editorial routes can trip, so `message`
 * describes that.
 */
const asConflict = (error: unknown, message: string): Error => {
  if (isUniqueViolation(error)) {
    return new HTTPException(409, { message })
  }
  return error instanceof Error ? error : new Error(String(error))
}

export { asConflict, isUniqueViolation }
