import { describe, expect, it } from 'vitest'
import { isTab, normalizeTabs, parseTabs, REQUIRED_TAB, serializeTabs, TAB_KEYS } from '@/lib/tabs'

describe('the tab registry', () => {
  it('recognises exactly the four tabs a page is built from', () => {
    expect([...TAB_KEYS]).toEqual(['overview', 'updates', 'wiki', 'contact'])
    expect(isTab('overview')).toBe(true)
    expect(isTab('forum')).toBe(false)
  })
})

describe('normalizeTabs', () => {
  it('keeps the order an editor chose', () => {
    expect(normalizeTabs(['overview', 'wiki', 'updates'])).toEqual(['overview', 'wiki', 'updates'])
  })

  it('forces the overview tab in front, whatever was sent', () => {
    expect(normalizeTabs(['contact', 'overview'])).toEqual(['overview', 'contact'])
    expect(normalizeTabs(['updates'])).toEqual(['overview', 'updates'])
    expect(normalizeTabs([])).toEqual([REQUIRED_TAB])
    expect(normalizeTabs(undefined)).toEqual([REQUIRED_TAB])
  })

  it('collapses duplicates instead of rendering the same tab twice', () => {
    expect(normalizeTabs(['wiki', 'wiki', 'overview', 'wiki'])).toEqual(['overview', 'wiki'])
  })

  it('drops an unknown key rather than failing the whole list', () => {
    expect(normalizeTabs(['updates', 'forum', 'wiki'])).toEqual(['overview', 'updates', 'wiki'])
  })
})

describe('parseTabs', () => {
  it('reads back what serializeTabs wrote', () => {
    expect(parseTabs(serializeTabs(['wiki', 'contact']))).toEqual(['overview', 'wiki', 'contact'])
  })

  /**
   * The read path is where a retired tab key or a corrupted blob shows up, and it must cost the
   * page a tab rather than 500-ing the application it was left on.
   */
  it.each([
    ['null', null],
    ['an empty string', ''],
    ['invalid JSON', '{not json'],
    ['an object', '{"overview":true}'],
    ['a list of the wrong type', '[1,2,3]'],
  ])('falls back to the overview tab alone for %s', (_label, raw) => {
    expect(parseTabs(raw)).toEqual([REQUIRED_TAB])
  })
})
