import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { linkListSchema, LINK_KINDS, MAX_LINKS, parseLinks, serializeLinks } from '@/lib/links'

const link = (over: Record<string, unknown> = {}) => ({ kind: 'github', url: 'https://example.com/a', ...over })

describe('the link schema', () => {
  it('accepts a link of every kind it advertises', () => {
    for (const kind of LINK_KINDS) {
      expect(v.parse(linkListSchema, [link({ kind })])).toHaveLength(1)
    }
  })

  it('refuses a kind it does not know', () => {
    expect(() => v.parse(linkListSchema, [link({ kind: 'myspace' })])).toThrow()
  })

  it('refuses anything that is not an absolute URL', () => {
    expect(() => v.parse(linkListSchema, [link({ url: '/relative' })])).toThrow()
  })

  /** `strictObject`: a misspelled key must be a 422, not a button that silently has no name. */
  it('refuses an unknown field rather than dropping it', () => {
    expect(() => v.parse(linkListSchema, [link({ lable: 'Download' })])).toThrow()
  })

  it('caps the list so a banner cannot grow thirty buttons', () => {
    const many = Array.from({ length: MAX_LINKS + 1 }, (_, index) => link({ url: `https://example.com/${index}` }))
    expect(() => v.parse(linkListSchema, many)).toThrow()
  })
})

describe('serializeLinks', () => {
  it('normalises a blank label into an absent one', () => {
    expect(JSON.parse(serializeLinks([link({ label: '   ' }) as never]))).toEqual([
      { kind: 'github', url: 'https://example.com/a', label: null },
    ])
  })

  it('trims a label it keeps', () => {
    const [stored] = JSON.parse(serializeLinks([link({ label: '  Source  ' }) as never]))
    expect(stored.label).toBe('Source')
  })

  it('writes an empty list for nothing at all', () => {
    expect(serializeLinks(undefined)).toBe('[]')
  })
})

describe('parseLinks', () => {
  it('reads back what serializeLinks wrote', () => {
    const stored = serializeLinks([link({ label: 'Source' }) as never])
    expect(parseLinks(stored)).toEqual([{ kind: 'github', url: 'https://example.com/a', label: 'Source' }])
  })

  /** A corrupted blob costs the row its buttons, never its page. */
  it.each([
    ['null', null],
    ['invalid JSON', '{['],
    ['an object', '{"kind":"github"}'],
  ])('falls back to no links for %s', (_label, raw) => {
    expect(parseLinks(raw)).toEqual([])
  })

  it('drops the malformed entries and keeps the sound ones', () => {
    const raw = JSON.stringify([
      { kind: 'github', url: 'https://example.com/a' },
      { kind: 'myspace', url: 'https://example.com/b' },
      { kind: 'website', url: '' },
      'not an object',
      { kind: 'website', url: 'https://example.com/c', label: 42 },
    ])

    expect(parseLinks(raw)).toEqual([
      { kind: 'github', url: 'https://example.com/a', label: null },
      { kind: 'website', url: 'https://example.com/c', label: null },
    ])
  })
})
