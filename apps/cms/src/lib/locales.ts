/**
 * The languages the landing page is published in, and the rules for serving them.
 *
 * The content model deliberately keeps one row per entry rather than one row per language. What a
 * translation changes is the handful of prose fields a visitor reads — everything else about an
 * entry (its slug, its ordering, its dates, its links, its `data` blob) is the same fact in every
 * language, and duplicating it per locale is how a reorder ends up applied to the English list and
 * not the Spanish one.
 *
 * So the row *is* the default locale, and `translations` carries an override map for the others:
 *
 *     { "es": { "title": "…", "summary": "…" } }
 *
 * A locale absent from the map, or a field absent from its object, falls back to the row. That
 * makes a half-translated entry render rather than 404, which is the right failure for a personal
 * site whose editor translates as they go.
 */

const DEFAULT_LOCALE = 'en'

const LOCALES = ['en', 'es'] as const

type Locale = (typeof LOCALES)[number]

/** Locales a translation may be written for — every locale except the one the row itself holds. */
const TRANSLATION_LOCALES = LOCALES.filter((locale) => locale !== DEFAULT_LOCALE) as [Locale, ...Locale[]]

const isLocale = (value: string): value is Locale => (LOCALES as readonly string[]).includes(value)

/** Prose fields of a content entry a translation may override. */
const CONTENT_TRANSLATABLE_FIELDS = ['title', 'subtitle', 'summary', 'body'] as const

/** Same, for a legal page. It has no subtitle. */
const LEGAL_TRANSLATABLE_FIELDS = ['title', 'summary', 'body'] as const

type TranslatableField = (typeof CONTENT_TRANSLATABLE_FIELDS)[number]

/** One locale's overrides. Every field is optional; a missing one means "use the row's text". */
type Translation = Partial<Record<TranslatableField, string | null>>

type Translations = Partial<Record<Locale, Translation>>

const isTranslatableField = (value: string): value is TranslatableField =>
  (CONTENT_TRANSLATABLE_FIELDS as readonly string[]).includes(value)

/**
 * Reads the stored blob back into a map, dropping anything that is not a known locale or not an
 * object. Like `parseJson` in the content service, this never throws: a blob an editor managed to
 * corrupt must cost that entry its translations, not take the whole listing down with it.
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
 * Locales this entry can be read in: the default one always, plus every locale with something
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
 * The locale a response is actually served in: the one asked for when the entry has anything in
 * it, and the default otherwise. Reported back so a caller never has to guess whether the text it
 * got is the translation or the fallback.
 */
const resolveLocale = (translations: Translations, requested: Locale): Locale =>
  requested !== DEFAULT_LOCALE && hasTranslation(translations, requested) ? requested : DEFAULT_LOCALE

/**
 * Normalises what an editor sent into what is stored: a field cleared with `null` or blanked to
 * whitespace is dropped rather than kept as an empty override, and a locale left with nothing in
 * it disappears entirely. Without that, `available_locales` would advertise a language whose every
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
  availableLocales,
  CONTENT_TRANSLATABLE_FIELDS,
  DEFAULT_LOCALE,
  hasTranslation,
  isLocale,
  LEGAL_TRANSLATABLE_FIELDS,
  localize,
  LOCALES,
  parseTranslations,
  resolveLocale,
  serializeTranslations,
  TRANSLATION_LOCALES,
}
export type { Locale, Translation, Translations }
