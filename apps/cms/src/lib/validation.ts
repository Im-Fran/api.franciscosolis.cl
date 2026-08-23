import * as v from 'valibot'
import { PAGINATION } from '@/lib/config'
import { TRANSLATION_LOCALES } from '@/lib/locales'

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
 * The per-locale overrides an editor may write, keyed by locale.
 *
 * `strictObject` for the same reason the collection schemas are: a misspelled `sumary` must be a
 * 422 rather than a field that silently never renders. The default locale is deliberately not a
 * valid key — that text lives in the row's own columns, and accepting it here would create a
 * second place for the English title to live and a question about which one wins.
 *
 * `null` clears one translated field while leaving the rest of the locale alone; the caller drops
 * the whole locale to remove it. Length caps mirror the source columns, so a translation can never
 * be longer than the text it translates is allowed to be.
 */
const translationFields = {
  title: v.optional(v.nullable(trimmedText(200))),
  summary: v.optional(v.nullable(trimmedText(600))),
}

const contentTranslations = v.optional(
  v.record(
    v.picklist(TRANSLATION_LOCALES),
    v.strictObject({
      ...translationFields,
      subtitle: v.optional(v.nullable(trimmedText(200))),
      body: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(100_000)))),
    }),
  ),
)

const legalTranslations = v.optional(
  v.record(
    v.picklist(TRANSLATION_LOCALES),
    v.strictObject({
      ...translationFields,
      body: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(200_000)))),
    }),
  ),
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

export {
  contentTranslations,
  dateInput,
  legalTranslations,
  optionalDate,
  optionalText,
  optionalUrl,
  paginationSchema,
  requiredText,
  tagList,
  trimmedText,
}
