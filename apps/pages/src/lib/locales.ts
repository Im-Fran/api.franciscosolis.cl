/**
 * The languages an application page is published in, and the rules for serving them.
 *
 * Same model as the CMS Worker's: one row per thing rather than one row per language. What a
 * translation changes is the handful of prose fields a visitor reads — everything else about an
 * application (its slug, its ordering, its links, its banner, the version number of a release) is
 * the same fact in every language, and duplicating it per locale is how a reorder ends up applied
 * to the English sidebar and not the Spanish one.
 *
 * So the row *is* the default locale, and `translations` carries an override map for the others:
 *
 *     { "es": { "name": "…", "overview_body": "…" } }
 *
 * A locale absent from the map, or a field absent from its object, falls back to the row. That
 * makes a half-translated page render rather than 404, which is the right failure for a site whose
 * editor translates as they go.
 *
 * The one thing this file does that the CMS's does not is take the field set as a parameter.
 * Three different kinds of row are translated here — an application, a release note, a wiki page —
 * and each has its own prose fields, so `TranslatableField` is their union and every caller says
 * which subset applies to the row it is holding.
 */

const DEFAULT_LOCALE = 'en'

const LOCALES = ['en', 'es'] as const

type Locale = (typeof LOCALES)[number]

/** Locales a translation may be written for — every locale except the one the row itself holds. */
const TRANSLATION_LOCALES = LOCALES.filter((locale) => locale !== DEFAULT_LOCALE) as [Locale, ...Locale[]]

const isLocale = (value: string): value is Locale => (LOCALES as readonly string[]).includes(value)

/**
 * Prose fields of an application a translation may override.
 *
 * The two tab bodies are in here and the tab *keys* are not: which tabs an application has is
 * structure, and a page that shows a Wiki tab in English and not in Spanish is a bug rather than a
 * translation.
 */
const APPLICATION_TRANSLATABLE_FIELDS = ['name', 'tagline', 'summary', 'overview_body', 'contact_body'] as const

/** Same, for a release note. The version label is not prose — `2.6.4` is `2.6.4` in every language. */
const UPDATE_TRANSLATABLE_FIELDS = ['title', 'body'] as const

/** Same, for a wiki page. Its slug and its icon are structure, so neither is translated. */
const WIKI_TRANSLATABLE_FIELDS = ['title', 'body'] as const

const ALL_TRANSLATABLE_FIELDS = [
  ...APPLICATION_TRANSLATABLE_FIELDS,
  ...UPDATE_TRANSLATABLE_FIELDS,
  ...WIKI_TRANSLATABLE_FIELDS,
] as const

type TranslatableField = (typeof ALL_TRANSLATABLE_FIELDS)[number]

/** One locale's overrides. Every field is optional; a missing one means "use the row's text". */
type Translation = Partial<Record<TranslatableField, string | null>>

type Translations = Partial<Record<Locale, Translation>>

const isTranslatableField = (value: string): value is TranslatableField =>
  (ALL_TRANSLATABLE_FIELDS as readonly string[]).includes(value)

/**
 * Reads the stored blob back into a map, dropping anything that is not a known locale or not an
 * object. Never throws: a blob an editor managed to corrupt must cost that row its translations,
 * not take the whole listing down with it.
 */
const parseTranslations = (raw: string | null): Translations => {
  if (!raw) {
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {}
  }

  const translations: Translations = {}
  for (const [locale, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isLocale(locale) || locale === DEFAULT_LOCALE) {
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue
    }

    const translation: Translation = {}
    for (const [field, text] of Object.entries(value as Record<string, unknown>)) {
      if (isTranslatableField(field) && typeof text === 'string') {
        translation[field] = text
      }
    }
    if (Object.keys(translation).length > 0) {
      translations[locale] = translation
    }
  }

  return translations
}

/** True when this locale carries at least one non-empty override. */
const hasTranslation = (translations: Translations, locale: Locale): boolean =>
  Object.values(translations[locale] ?? {}).some((text) => typeof text === 'string' && text.trim().length > 0)

/**
 * Locales this row can be read in: the default one always, plus every locale with something
 * written for it. What a language switcher on the website is built from.
 */
const availableLocales = (translations: Translations): Locale[] => [
  DEFAULT_LOCALE,
  ...TRANSLATION_LOCALES.filter((locale) => hasTranslation(translations, locale)),
]

/**
 * Overlays a locale's text on the row's own.
 *
 * Only non-empty strings win. An override stored as `null` or `""` is an editor clearing a field
 * they had translated, which means "fall back", not "publish an empty heading".
 */
const localize = <T extends Partial<Record<TranslatableField, string | null>>>(
  base: T,
  translations: Translations,
  locale: Locale,
  fields: readonly TranslatableField[],
): T => {
  const translation = translations[locale]
  if (!translation || locale === DEFAULT_LOCALE) {
    return base
  }

  const localized = { ...base }
  for (const field of fields) {
    const text = translation[field]
    if (typeof text === 'string' && text.trim().length > 0) {
      localized[field] = text as T[TranslatableField]
    }
  }
  return localized
}

/**
 * The locale a response is actually served in: the one asked for when the row has anything in it,
 * and the default otherwise. Reported back so a caller never has to guess whether the text it got
 * is the translation or the fallback.
 */
const resolveLocale = (translations: Translations, requested: Locale): Locale =>
  requested !== DEFAULT_LOCALE && hasTranslation(translations, requested) ? requested : DEFAULT_LOCALE

/**
 * Normalises what an editor sent into what is stored: a field cleared with `null` or blanked to
 * whitespace is dropped rather than kept as an empty override, and a locale left with nothing in it
 * disappears entirely. Without that, `available_locales` would advertise a language whose every
 * field falls back, and the website would offer a translation that does not exist.
 */
const serializeTranslations = (input: Translations | undefined): string => {
  const cleaned: Translations = {}

  for (const [locale, translation] of Object.entries(input ?? {})) {
    if (!isLocale(locale) || locale === DEFAULT_LOCALE || !translation) {
      continue
    }

    const kept: Translation = {}
    for (const [field, text] of Object.entries(translation)) {
      if (typeof text === 'string' && text.trim().length > 0) {
        kept[field as TranslatableField] = text
      }
    }
    if (Object.keys(kept).length > 0) {
      cleaned[locale] = kept
    }
  }

  return JSON.stringify(cleaned)
}

export {
  ALL_TRANSLATABLE_FIELDS,
  APPLICATION_TRANSLATABLE_FIELDS,
  availableLocales,
  DEFAULT_LOCALE,
  hasTranslation,
  isLocale,
  localize,
  LOCALES,
  parseTranslations,
  resolveLocale,
  serializeTranslations,
  TRANSLATION_LOCALES,
  UPDATE_TRANSLATABLE_FIELDS,
  WIKI_TRANSLATABLE_FIELDS,
}
export type { Locale, TranslatableField, Translation, Translations }
