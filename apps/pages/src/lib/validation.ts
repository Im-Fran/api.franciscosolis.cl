import * as v from 'valibot'
import { BODY_LIMITS, PAGINATION, TRANSLATABLE_FIELD_LIMITS } from '@/lib/config'
import {
  APPLICATION_TRANSLATABLE_FIELDS,
  TRANSLATION_LOCALES,
  UPDATE_TRANSLATABLE_FIELDS,
  WIKI_TRANSLATABLE_FIELDS,
} from '@/lib/locales'

/**
 * Schema fragments shared by the admin routes.
 *
 * The `undefined` / `null` distinction is deliberate everywhere in this Worker's PATCH bodies: a
 * field left out means "leave it alone", an explicit `null` means "clear it". `v.optional`
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

/** A settable, clearable Markdown document. Not trimmed: trailing structure in Markdown is meaning. */
const optionalBody = (max: number) => v.optional(v.nullable(v.pipe(v.string(), v.maxLength(max))))

/**
 * A CSS hex colour. Restricted to `#rgb`/`#rrggbb` rather than accepting any CSS colour: the value
 * is interpolated into a style on the website, and the narrow form is one a front-end can also
 * safely parse into components for a gradient.
 */
const optionalHexColor = v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/))))

/**
 * Builds the per-locale override schema for a set of prose fields.
 *
 * `strictObject` for the same reason the link schema is: a misspelled `titel` must be a 422 rather
 * than a field that silently never renders. The default locale is deliberately not a valid key —
 * that text lives in the row's own columns, and accepting it here would create a second home for
 * the English name and a question about which one wins.
 *
 * `null` clears one translated field while leaving the rest of the locale alone; the caller drops
 * the whole locale to remove it.
 */
const translationsFor = (fields: Record<string, v.GenericSchema>) =>
  v.optional(v.record(v.picklist(TRANSLATION_LOCALES), v.strictObject(fields)))

const prose = (max: number) => v.optional(v.nullable(trimmedText(max)))
const proseBody = (max: number) => v.optional(v.nullable(v.pipe(v.string(), v.maxLength(max))))

/** Length caps mirror the source columns, so a translation is never allowed to outgrow its source. */
const applicationTranslations = translationsFor({
  name: prose(TRANSLATABLE_FIELD_LIMITS.name),
  tagline: prose(TRANSLATABLE_FIELD_LIMITS.tagline),
  summary: prose(TRANSLATABLE_FIELD_LIMITS.summary),
  overview_body: proseBody(BODY_LIMITS.page),
  contact_body: proseBody(BODY_LIMITS.page),
})

const updateTranslations = translationsFor({
  title: prose(TRANSLATABLE_FIELD_LIMITS.title),
  body: proseBody(BODY_LIMITS.update),
})

const wikiTranslations = translationsFor({
  title: prose(TRANSLATABLE_FIELD_LIMITS.title),
  body: proseBody(BODY_LIMITS.page),
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
  application: APPLICATION_TRANSLATABLE_FIELDS,
  update: UPDATE_TRANSLATABLE_FIELDS,
  wiki: WIKI_TRANSLATABLE_FIELDS,
} as const

export {
  applicationTranslations,
  dateInput,
  optionalBody,
  optionalDate,
  optionalHexColor,
  optionalText,
  optionalUrl,
  paginationSchema,
  requiredText,
  TRANSLATABLE,
  trimmedText,
  updateTranslations,
  wikiTranslations,
}
