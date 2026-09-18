import * as v from 'valibot'
import { BODY_LIMITS, PAGINATION } from '@/lib/config'
import {
  ARTICLE_TRANSLATABLE_FIELDS,
  CATEGORY_TRANSLATABLE_FIELDS,
  LABEL_TRANSLATABLE_FIELDS,
  TRANSLATION_LOCALES,
} from '@/lib/locales'

/**
 * Schema fragments shared by the routes.
 *
 * The `undefined` / `null` distinction is deliberate in every PATCH body here, as in the cms and
 * pages Workers: a field left out means "leave it alone", an explicit `null` means "clear it".
 * `v.optional` expresses the first, `v.nullable` the second, and most editable fields need both.
 */

/** An ISO 8601 date or datetime, parsed into a `Date`. */
const dateInput = v.pipe(
  v.string(),
  v.transform((value) => new Date(value)),
  v.check((date) => !Number.isNaN(date.getTime()), 'must be an ISO 8601 date'),
)

const optionalDate = v.optional(v.nullable(dateInput))

const trimmedText = (max: number) => v.pipe(v.string(), v.trim(), v.maxLength(max))

/** A required, non-empty text field. */
const requiredText = (max: number) => v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max))

/** A settable, clearable text field. */
const optionalText = (max: number) => v.optional(v.nullable(trimmedText(max)))

const optionalUrl = v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.url(), v.maxLength(2048))))

/** A settable, clearable Markdown document. Not trimmed: trailing structure in Markdown is meaning. */
const optionalBody = (max: number) => v.optional(v.nullable(v.pipe(v.string(), v.maxLength(max))))

const optionalHexColor = v.optional(
  v.nullable(v.pipe(v.string(), v.trim(), v.regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/))),
)

/**
 * An email address, lowercased on the way in.
 *
 * Normalising here rather than at each call site is what makes the comparisons downstream safe:
 * a participant lookup, the requester-session check in `requireTicketAccess` and the per-sender rate
 * limit all compare a stored address against a claim, and one of them forgetting to lowercase is a
 * silent authorisation bug rather than a visible one.
 */
const emailAddress = v.pipe(
  v.string(),
  v.trim(),
  v.toLowerCase(),
  v.email('must be an email address'),
  v.maxLength(320),
)

const optionalEmail = v.optional(v.nullable(emailAddress))

/**
 * Builds the per-locale override schema for a set of prose fields.
 *
 * `strictObject` so a misspelled `titel` is a 422 rather than a field that silently never renders.
 * The default locale is deliberately not a valid key — that text lives in the row's own columns.
 */
const translationsFor = (fields: Record<string, v.GenericSchema>) =>
  v.optional(v.record(v.picklist(TRANSLATION_LOCALES), v.strictObject(fields)))

const prose = (max: number) => v.optional(v.nullable(trimmedText(max)))
const proseBody = (max: number) => v.optional(v.nullable(v.pipe(v.string(), v.maxLength(max))))

/** Length caps mirror the source columns, so a translation is never allowed to outgrow its source. */
const articleTranslations = translationsFor({
  title: prose(200),
  summary: prose(600),
  body: proseBody(BODY_LIMITS.article),
})

const categoryTranslations = translationsFor({
  name: prose(120),
  description: prose(600),
})

const labelTranslations = translationsFor({
  name: prose(60),
  description: prose(300),
})

/**
 * Query-string pagination. Values arrive as strings, so the bounds are enforced after the
 * transform — `limit` is capped rather than rejected-on-huge so a client cannot ask for the whole
 * table.
 */
const paginationSchema = v.object({
  limit: v.optional(
    v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(PAGINATION.maxLimit)),
  ),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
})

/** The fields each kind of row may be translated in, re-exported so routes import one module. */
const TRANSLATABLE = {
  article: ARTICLE_TRANSLATABLE_FIELDS,
  category: CATEGORY_TRANSLATABLE_FIELDS,
  label: LABEL_TRANSLATABLE_FIELDS,
} as const

export {
  articleTranslations,
  categoryTranslations,
  dateInput,
  emailAddress,
  labelTranslations,
  optionalBody,
  optionalDate,
  optionalEmail,
  optionalHexColor,
  optionalText,
  optionalUrl,
  paginationSchema,
  requiredText,
  TRANSLATABLE,
  trimmedText,
}
