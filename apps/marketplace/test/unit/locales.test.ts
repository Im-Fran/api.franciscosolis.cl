import { describe, expect, it } from 'vitest'
import {
  PRODUCT_TRANSLATABLE_FIELDS,
  availableLocales,
  DEFAULT_LOCALE,
  hasTranslation,
  localize,
  parseTranslations,
  resolveLocale,
  serializeTranslations,
  RELEASE_TRANSLATABLE_FIELDS,
} from '@/lib/locales'

describe('parseTranslations', () => {
  it('keeps a known locale with known fields', () => {
    expect(parseTranslations('{"es":{"name":"Batería Abierta"}}')).toEqual({ es: { name: 'Batería Abierta' } })
  })

  it('drops the default locale, because the row itself is that language', () => {
    expect(parseTranslations('{"en":{"name":"OpenBattery"}}')).toEqual({})
  })

  it('drops a locale the service does not publish', () => {
    expect(parseTranslations('{"fr":{"name":"…"}}')).toEqual({})
  })

  it('drops a field that is not translatable, so structure cannot be overridden per language', () => {
    expect(parseTranslations('{"es":{"slug":"bateria","name":"Batería"}}')).toEqual({ es: { name: 'Batería' } })
  })

  it.each([
    ['null', null],
    ['invalid JSON', '{'],
    ['an array', '[]'],
  ])('falls back to no translations for %s', (_label, raw) => {
    expect(parseTranslations(raw)).toEqual({})
  })
})

describe('serializeTranslations', () => {
  it('drops a field cleared to null or blanked to whitespace', () => {
    expect(serializeTranslations({ es: { name: null, tagline: '   ', summary: 'Resumen' } })).toBe(
      '{"es":{"summary":"Resumen"}}',
    )
  })

  /**
   * A locale whose every field falls back is a language the switcher would offer and the reader
   * would find in English, so it does not get stored at all.
   */
  it('drops a locale left with nothing in it', () => {
    expect(serializeTranslations({ es: { name: '  ' } })).toBe('{}')
  })
})

describe('availableLocales and resolveLocale', () => {
  it('always lists the default locale', () => {
    expect(availableLocales({})).toEqual([DEFAULT_LOCALE])
  })

  it('lists a locale that carries something', () => {
    expect(availableLocales({ es: { name: 'Batería' } })).toEqual(['en', 'es'])
  })

  it('does not list a locale whose only field is empty', () => {
    expect(hasTranslation({ es: { name: '   ' } }, 'es')).toBe(false)
    expect(availableLocales({ es: { name: '   ' } })).toEqual(['en'])
  })

  it('serves the default locale when the one asked for has nothing behind it', () => {
    expect(resolveLocale({}, 'es')).toBe('en')
    expect(resolveLocale({ es: { name: 'Batería' } }, 'es')).toBe('es')
  })
})

describe('localize', () => {
  const base = { name: 'OpenBattery', tagline: 'Battery telemetry', summary: null, overview_body: '# Hi', contact_body: null }

  it('overlays only the fields that were translated, leaving the rest to fall back', () => {
    const result = localize(base, { es: { name: 'Batería Abierta' } }, 'es', PRODUCT_TRANSLATABLE_FIELDS)

    expect(result.name).toBe('Batería Abierta')
    expect(result.tagline).toBe('Battery telemetry')
  })

  it('ignores an override that is empty, which is an editor clearing a translation', () => {
    const result = localize(base, { es: { name: '   ' } }, 'es', PRODUCT_TRANSLATABLE_FIELDS)

    expect(result.name).toBe('OpenBattery')
  })

  it('leaves the row alone when the default locale is asked for', () => {
    const result = localize(base, { es: { name: 'Batería Abierta' } }, 'en', PRODUCT_TRANSLATABLE_FIELDS)

    expect(result.name).toBe('OpenBattery')
  })

  /**
   * The field set is per kind of row, and that is the whole reason it is a parameter: a release
   * carries `title`/`body` and nothing else, so an `name` sitting in its map must not leak onto it.
   */
  it('only applies the fields the caller said belong to this kind of row', () => {
    const release = { title: 'Full 1.21.11 support', body: 'Changes' }
    const result = localize(
      release,
      { es: { title: 'Soporte completo de 1.21.11', name: 'no aplica' } },
      'es',
      RELEASE_TRANSLATABLE_FIELDS,
    )

    expect(result).toEqual({ title: 'Soporte completo de 1.21.11', body: 'Changes' })
  })
})
