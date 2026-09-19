import { describe, expect, it } from 'vitest'
import { CATEGORIES, CATEGORY_KEYS, describeCategory, isCategory, parseCategory } from '@/lib/categories'

describe('the category registry', () => {
  it('exposes exactly the keys it defines, each with a fallback label', () => {
    expect(CATEGORY_KEYS).toEqual(Object.keys(CATEGORIES))
    for (const key of CATEGORY_KEYS) {
      expect(CATEGORIES[key].name.length).toBeGreaterThan(0)
      expect(CATEGORIES[key].description.length).toBeGreaterThan(0)
    }
  })

  it('keeps an escape hatch, the way the link vocabulary does', () => {
    expect(isCategory('other')).toBe(true)
  })
})

describe('parseCategory', () => {
  /**
   * Lenient on read, like `parseTabs` and `parsePricingMode`: a category retired in a later version
   * of this Worker must cost the page its chip, not its existence.
   */
  it.each([
    ['null', null],
    ['an empty string', ''],
    ['a retired key', 'browser_extension'],
  ])('answers null for %s', (_label, raw) => {
    expect(parseCategory(raw)).toBeNull()
  })

  it('reads back every key it knows', () => {
    for (const key of CATEGORY_KEYS) {
      expect(parseCategory(key)).toBe(key)
    }
  })
})

describe('describeCategory', () => {
  it('serializes the key and its fallback label together, never the key alone', () => {
    expect(describeCategory('library')).toEqual({ key: 'library', name: CATEGORIES.library.name })
  })

  it('is null for a product nobody categorised', () => {
    expect(describeCategory(null)).toBeNull()
  })
})
