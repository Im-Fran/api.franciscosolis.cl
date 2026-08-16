import { describe, expect, it } from 'vitest'
import { SLUG_PATTERN, slugify } from '@/lib/slug'

describe('slugify', () => {
  it('lowercases and joins words with a single dash', () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })

  it('strips Spanish accents instead of dropping the letter', () => {
    // The CMS mostly holds Spanish; losing the accented letter would mangle half the titles.
    expect(slugify('Ingeniería civil')).toBe('ingenieria-civil')
    expect(slugify('Diseño de Añoranza')).toBe('diseno-de-anoranza')
    expect(slugify('ÁÉÍÓÚ')).toBe('aeiou')
  })

  it('collapses a run of non-alphanumerics into one dash', () => {
    expect(slugify('a  ---  b')).toBe('a-b')
    expect(slugify('C++ / Rust & Go')).toBe('c-rust-go')
    expect(slugify('one_two.three')).toBe('one-two-three')
  })

  it('trims leading and trailing dashes', () => {
    expect(slugify('  --hello--  ')).toBe('hello')
    expect(slugify('!!!edge!!!')).toBe('edge')
  })

  it('drops characters no ASCII fold exists for', () => {
    expect(slugify('日本語 project')).toBe('project')
    expect(slugify('🚀 launch')).toBe('launch')
  })

  it('returns an empty string when nothing alphanumeric survives', () => {
    // The create routes rely on this to answer 422 rather than store a blank slug.
    expect(slugify('!!!')).toBe('')
    expect(slugify('   ')).toBe('')
    expect(slugify('')).toBe('')
  })

  it('keeps digits, which version-like titles need', () => {
    expect(slugify('Terms v2.1')).toBe('terms-v2-1')
  })

  it('truncates at 80 characters', () => {
    const slug = slugify('a'.repeat(200))
    expect(slug).toHaveLength(80)
    expect(slug).toBe('a'.repeat(80))
  })

  it('truncates after trimming, so a dash can end up last', () => {
    // Documented gap: the cut happens after the trim, so a slug produced here is not always one
    // `SLUG_PATTERN` would accept back from a client.
    const slug = slugify(`${'a'.repeat(79)} b`)
    expect(slug).toBe(`${'a'.repeat(79)}-`)
    expect(SLUG_PATTERN.test(slug)).toBe(false)
  })
})

describe('SLUG_PATTERN', () => {
  it('accepts a plain slug', () => {
    expect(SLUG_PATTERN.test('hello-world')).toBe(true)
    expect(SLUG_PATTERN.test('a')).toBe(true)
    expect(SLUG_PATTERN.test('9')).toBe(true)
    expect(SLUG_PATTERN.test('v2-1-final')).toBe(true)
  })

  it('rejects a leading or trailing dash', () => {
    expect(SLUG_PATTERN.test('-hello')).toBe(false)
    expect(SLUG_PATTERN.test('hello-')).toBe(false)
    expect(SLUG_PATTERN.test('-')).toBe(false)
  })

  it('rejects uppercase', () => {
    expect(SLUG_PATTERN.test('Hello')).toBe(false)
    expect(SLUG_PATTERN.test('helloWorld')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(SLUG_PATTERN.test('')).toBe(false)
  })

  it('accepts exactly 80 characters and rejects 81', () => {
    expect(SLUG_PATTERN.test('a'.repeat(80))).toBe(true)
    expect(SLUG_PATTERN.test('a'.repeat(81))).toBe(false)
  })

  it('rejects anything outside [a-z0-9-]', () => {
    expect(SLUG_PATTERN.test('hello world')).toBe(false)
    expect(SLUG_PATTERN.test('hello_world')).toBe(false)
    expect(SLUG_PATTERN.test('hola-señor')).toBe(false)
    expect(SLUG_PATTERN.test('a/b')).toBe(false)
  })

  it('is not anchored loosely enough to pass a multi-line payload', () => {
    // `^`/`$` without the `m` flag, so an embedded newline cannot smuggle a second line through.
    expect(SLUG_PATTERN.test('ok\nnot ok')).toBe(false)
  })
})
