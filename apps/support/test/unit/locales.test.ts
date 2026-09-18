import { describe, expect, it } from 'vitest'
import {
  ARTICLE_TRANSLATABLE_FIELDS,
  availableLocales,
  localize,
  parseTranslations,
  resolveLocale,
  serializeTranslations,
} from '@/lib/locales'

describe('parseTranslations', () => {
  it.each([
    ['null', null],
    ['an empty string', ''],
    ['invalid JSON', '{not json'],
    ['an array', '[1,2,3]'],
    ['a scalar', '"es"'],
  ])('falls back to an empty map for %s', (_label, raw) => {
    expect(parseTranslations(raw)).toEqual({})
  })

  it('drops unknown locales and unknown fields rather than throwing', () => {
    const parsed = parseTranslations('{"es":{"title":"Hola","nonsense":"x"},"fr":{"title":"Salut"}}')
    expect(parsed).toEqual({ es: { title: 'Hola' } })
  })

  it('drops the default locale, which lives in the row itself', () => {
    expect(parseTranslations('{"en":{"title":"Hello"}}')).toEqual({})
  })
})

describe('localize', () => {
  const base = { title: 'Reset your password', summary: 'How to', body: 'Steps' }

  it('overlays the translated fields', () => {
    const result = localize(base, { es: { title: 'Restablecer tu contraseña' } }, 'es', ARTICLE_TRANSLATABLE_FIELDS)
    expect(result.title).toBe('Restablecer tu contraseña')
    // A field with no override falls back, so a half-translated article still renders.
    expect(result.summary).toBe('How to')
  })

  it('treats a blank override as "fall back", not as "publish nothing"', () => {
    const result = localize(base, { es: { title: '   ' } }, 'es', ARTICLE_TRANSLATABLE_FIELDS)
    expect(result.title).toBe('Reset your password')
  })

  it('is a no-op for the default locale', () => {
    expect(localize(base, { es: { title: 'x' } }, 'en', ARTICLE_TRANSLATABLE_FIELDS)).toEqual(base)
  })
})

describe('availableLocales and resolveLocale', () => {
  it('advertises only languages that actually have text', () => {
    expect(availableLocales({})).toEqual(['en'])
    expect(availableLocales({ es: { title: 'Hola' } })).toEqual(['en', 'es'])
    expect(availableLocales({ es: { title: '  ' } })).toEqual(['en'])
  })

  it('reports the locale actually served, so a caller never has to guess', () => {
    expect(resolveLocale({ es: { title: 'Hola' } }, 'es')).toBe('es')
    expect(resolveLocale({}, 'es')).toBe('en')
  })
})

describe('serializeTranslations', () => {
  it('drops blank fields and the locales left empty by that', () => {
    expect(serializeTranslations({ es: { title: '  ', summary: null } })).toBe('{}')
  })

  it('keeps what was actually written', () => {
    expect(serializeTranslations({ es: { title: 'Hola' } })).toBe('{"es":{"title":"Hola"}}')
  })
})
