import * as v from 'valibot'
import { PAGINATION } from '@/lib/config'

/**
 * Schema fragments shared by the admin routes.
 *
 * The `undefined` / `null` distinction is deliberate everywhere in this Worker's PATCH bodies:
 * a field left out means "leave it alone", an explicit `null` means "clear it". `v.optional`
 * expresses the first, `v.nullable` the second, and most editable fields need both.
 */

/** An ISO 8601 date or datetime, parsed into a `Date`. */
const dateInput = v.pipe(
  v.string(),
  v.transform((value) => new Date(value)),
  v.check((date) => !Number.isNaN(date.getTime()), 'must be an ISO 8601 date'),
)

/** A settable, clearable date field on a PATCH body. */
const optionalDate = v.optional(v.nullable(dateInput))

const trimmedText = (max: number) => v.pipe(v.string(), v.trim(), v.maxLength(max))

/** A required, non-empty text field. */
const requiredText = (max: number) => v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max))

/** A settable, clearable text field. */
const optionalText = (max: number) => v.optional(v.nullable(trimmedText(max)))

/** A settable, clearable absolute URL. */
const optionalUrl = v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.url(), v.maxLength(2048))))

/** Tags are stored lowercased so filtering by tag does not have to care about casing. */
const tagList = v.optional(
  v.array(v.pipe(v.string(), v.trim(), v.toLowerCase(), v.minLength(1), v.maxLength(60))),
)

/**
 * Query-string pagination. Values arrive as strings, so the bounds are enforced after the
 * transform — `limit` is capped rather than rejected-on-huge so a client cannot ask for the
 * whole table.
 */
const paginationSchema = v.object({
  limit: v.optional(
    v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(PAGINATION.maxLimit)),
  ),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
})

export { dateInput, optionalDate, optionalText, optionalUrl, paginationSchema, requiredText, tagList, trimmedText }
