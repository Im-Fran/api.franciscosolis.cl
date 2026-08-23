import { describe, expect, it } from 'vitest'
import {
  availableLocales,
  CONTENT_TRANSLATABLE_FIELDS,
  DEFAULT_LOCALE,
  hasTranslation,
  isLocale,
  LEGAL_TRANSLATABLE_FIELDS,
  localize,
  parseTranslations,
  resolveLocale,
  serializeTranslations,
} from '@/lib/locales'

describe('isLocale', () => {
  it('accepts the published languages and nothing else', () => {
    expect(isLocale('en')).toBe(true)
    expect(isLocale('es')).toBe(true)
    expect(isLocale('fr')).toBe(false)
    expect(isLocale('EN')).toBe(false)
  })
})

describe('parseTranslations', () => {
  it('reads a well-formed blob', () => {
    expect(parseTranslations('{"es":{"title":"Hola","summary":"Resumen"}}')).toEqual({
      es: { title: 'Hola', summary: 'Resumen' },
    })
  })

  it('falls back to an empty map rather than throwing', () => {
    // Same rule as `parseJson` in the content service: one corrupt blob costs that entry its
    // translations, it does not take the listing — and with it the landing page — down.
    expect(parseTranslations('{not json')).toEqual({})
    expect(parseTranslations(null)).toEqual({})
    expect(parseTranslations('')).toEqual({})
    expect(parseTranslations('["es"]')).toEqual({})
    expect(parseTranslations('"a string"')).toEqual({})
  })

  it('drops locales nobody publishes and fields nobody translates', () => {
    const parsed = parseTranslations('{"fr":{"title":"Bonjour"},"es":{"title":"Hola","slug":"hola"}}')

    expect(parsed).toEqual({ es: { title: 'Hola' } })
  })

  it('drops the default locale, which lives in the row itself', () => {
    // Accepting it would create a second place for the English title to live, and a question
    // about which of the two wins.
    expect(parseTranslations('{"en":{"title":"Shadow"},"es":{"title":"Hola"}}')).toEqual({
      es: { title: 'Hola' },
    })
  })

  it('drops a locale whose object is not an object, and one left with nothing in it', () => {
    expect(parseTranslations('{"es":"Hola"}')).toEqual({})
    expect(parseTranslations('{"es":{"title":42}}')).toEqual({})
  })
})

describe('hasTranslation', () => {
  it('sees text, but not an empty or whitespace-only override', () => {
    expect(hasTranslation({ es: { title: 'Hola' } }, 'es')).toBe(true)
    expect(hasTranslation({ es: { title: '   ' } }, 'es')).toBe(false)
    expect(hasTranslation({ es: { title: null } }, 'es')).toBe(false)
    expect(hasTranslation({}, 'es')).toBe(false)
  })
})

describe('availableLocales', () => {
  it('always offers the default locale', () => {
    expect(availableLocales({})).toEqual([DEFAULT_LOCALE])
  })

  it('adds a locale only once something is written for it', () => {
    expect(availableLocales({ es: { title: 'Hola' } })).toEqual(['en', 'es'])
    expect(availableLocales({ es: {} })).toEqual(['en'])
  })
})

describe('localize', () => {
  const base = { title: 'Projects', subtitle: 'Web App', summary: null, body: '# Body' }

  it('overlays the fields a locale translated and leaves the rest alone', () => {
    const localized = localize(
      base,
      { es: { title: 'Proyectos', summary: 'Resumen' } },
      'es',
      CONTENT_TRANSLATABLE_FIELDS,
    )

    expect(localized).toEqual({
      title: 'Proyectos',
      // Untranslated, so the entry's own text stands rather than the field going missing.
      subtitle: 'Web App',
      summary: 'Resumen',
      body: '# Body',
    })
  })

  it('ignores a cleared or blank override, which means "fall back", not "publish nothing"', () => {
    expect(localize(base, { es: { title: null, subtitle: '  ' } }, 'es', CONTENT_TRANSLATABLE_FIELDS)).toEqual(base)
  })

  it('never touches the default locale, whatever is stored under it', () => {
    expect(localize(base, { es: { title: 'Proyectos' } }, 'en', CONTENT_TRANSLATABLE_FIELDS)).toEqual(base)
  })

  it('only overlays the fields it was given, so a legal page keeps no subtitle', () => {
    const page = { title: 'Terms', summary: 'The terms', body: '# Terms' }
    const localized = localize(page, { es: { title: 'Términos', subtitle: 'Nope' } }, 'es', LEGAL_TRANSLATABLE_FIELDS)

    expect(localized).toEqual({ title: 'Términos', summary: 'The terms', body: '# Terms' })
  })
})

describe('resolveLocale', () => {
  it('serves the language asked for when there is one', () => {
    expect(resolveLocale({ es: { title: 'Hola' } }, 'es')).toBe('es')
  })

  it('falls back to the default, and says so, when there is not', () => {
    // The caller reads `locale` off the response instead of guessing whether it got the
    // translation or the original.
    expect(resolveLocale({}, 'es')).toBe('en')
    expect(resolveLocale({ es: { title: '  ' } }, 'es')).toBe('en')
  })
})

describe('serializeTranslations', () => {
  it('stores what an editor wrote', () => {
    expect(serializeTranslations({ es: { title: 'Hola', body: '# Hola' } })).toBe(
      '{"es":{"title":"Hola","body":"# Hola"}}',
    )
  })

  it('drops a cleared field and a locale left empty by it', () => {
    // Otherwise `available_locales` would advertise a language whose every field falls back.
    expect(serializeTranslations({ es: { title: null, summary: '   ' } })).toBe('{}')
    expect(serializeTranslations({ es: { title: 'Hola', summary: null } })).toBe('{"es":{"title":"Hola"}}')
  })

  it('turns an absent map into an empty one', () => {
    expect(serializeTranslations(undefined)).toBe('{}')
  })
})
