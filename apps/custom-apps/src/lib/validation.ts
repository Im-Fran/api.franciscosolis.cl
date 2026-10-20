import * as v from 'valibot'
import { PAGINATION, WEEKDAYS } from '@/lib/config'

/**
 * Schema fragments shared by both surfaces.
 *
 * On a PATCH body, a field left out means "leave it alone" and an explicit `null` means "clear it":
 * `v.optional` expresses the first, `v.nullable` the second.
 */

const trimmedText = (max: number) => v.pipe(v.string(), v.trim(), v.maxLength(max))

/** A required, non-empty text field. */
const requiredText = (max: number) => v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max))

/** A settable, clearable text field. An empty string is stored as null. */
const optionalText = (max: number) =>
  v.optional(v.nullable(v.pipe(trimmedText(max), v.transform((value) => (value === '' ? null : value)))))

/** A settable, clearable absolute http(s) URL. */
const optionalUrl = v.optional(
  v.nullable(v.pipe(v.string(), v.trim(), v.url(), v.regex(/^https?:\/\//i, 'must be an http(s) URL'), v.maxLength(2048))),
)

/** An ISO 8601 date or datetime, parsed into a `Date`. */
const dateInput = v.pipe(
  v.string(),
  v.transform((value) => new Date(value)),
  v.check((date) => !Number.isNaN(date.getTime()), 'must be an ISO 8601 date'),
)

/** A calendar day, `YYYY-MM-DD`. */
const dayInput = v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date'))

/** A bare hostname — what a web app's `domain` holds. Lowercased; no scheme, path or port. */
const hostnameInput = v.pipe(
  v.string(),
  v.trim(),
  v.toLowerCase(),
  v.maxLength(253),
  v.regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'must be a hostname, e.g. shop.example.cl'),
)

const timeOfDay = v.pipe(v.string(), v.regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'must be HH:MM'))

/**
 * Declared operating hours: per weekday, zero or more `[start, end)` windows. What the usage
 * heatmap's "not in use" is read against, and what a suggested maintenance window must stay *inside*:
 * outside its hours a device may be switched off, and a device that is off installs nothing.
 */
const operatingHoursSchema = v.pipe(
  v.strictObject({
    timezone: v.optional(
      v.pipe(
        v.string(),
        v.check((zone) => {
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: zone })
            return true
          } catch {
            return false
          }
        }, 'must be an IANA time zone'),
      ),
      'America/Santiago',
    ),
    days: v.record(
      v.picklist(WEEKDAYS),
      v.pipe(v.array(v.strictObject({ start: timeOfDay, end: timeOfDay })), v.maxLength(6)),
    ),
  }),
  v.check(
    (hours) => Object.values(hours.days).every((windows) => windows.every((window) => window.start < window.end)),
    'every window must end after it starts',
  ),
)

/** Query-string pagination, capped rather than refused so a client cannot ask for the whole table. */
const paginationQuery = {
  limit: v.optional(
    v.pipe(v.string(), v.regex(/^\d{1,4}$/), v.transform(Number), v.minValue(1), v.transform((n) => Math.min(n, PAGINATION.maxLimit))),
  ),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,7}$/), v.transform(Number))),
}

/** `true` / `false` in a query string. */
const booleanQuery = v.optional(v.pipe(v.picklist(['true', 'false']), v.transform((value) => value === 'true')))

/** A text search term. */
const searchQuery = v.optional(v.pipe(v.string(), v.trim(), v.maxLength(120)))

/** An id in a path segment: a UUID. Anything else is a 404, not a database round trip. */
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

export {
  booleanQuery,
  dateInput,
  dayInput,
  hostnameInput,
  isUuid,
  operatingHoursSchema,
  optionalText,
  optionalUrl,
  paginationQuery,
  requiredText,
  searchQuery,
  trimmedText,
}
