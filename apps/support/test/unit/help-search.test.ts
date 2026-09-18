import { describe, expect, it } from 'vitest'
import { HELP_SEARCH } from '@/lib/config'
import { toMatchQuery } from '@/services/help-search'
import { chunk } from '@/services/vectors'

describe('toMatchQuery', () => {
  it('quotes every term and only prefixes the last one', () => {
    // The prefix star is what makes typing "billi" find "billing"; putting one on every term makes
    // a short query match half the corpus.
    expect(toMatchQuery('billing question')).toBe('"billing" "question"*')
  })

  it.each([
    ['an operator', 'cat NOT dog'],
    ['a quote', 'say "hello"'],
    ['a hyphen', 'sign-in problem'],
    ['a colon', 'error: failed'],
    ['a prefix star of their own', 'bill*'],
    ['parentheses', '(a OR b)'],
    ['a caret', 'a^2'],
    ['C++', 'c++ compiler'],
    ['an unbalanced quote', 'it"s broken'],
  ])('renders %s inert rather than letting it reach FTS5 as syntax', (_label, input) => {
    const query = toMatchQuery(input)
    expect(query).not.toBeNull()
    // Everything survives only inside double quotes, where FTS5 treats it as literal text. The only
    // characters outside the quotes are the separators and the trailing star.
    expect(query!.replace(/"[^"]*"/g, '').replace(/[\s*]/g, '')).toBe('')
  })

  it('doubles an embedded quote rather than ending the phrase early', () => {
    expect(toMatchQuery('say "hi"')).toBe('"say" "hi"*')
  })

  it.each([
    ['an empty string', ''],
    ['only whitespace', '   '],
    ['only punctuation', '!!! ??? ...'],
    ['only an emoji', '🙂'],
  ])('answers null for %s', (_label, input) => {
    // `MATCH ''` is a syntax error, and a syntax error from D1 arrives as a 500 with the query in
    // the logs. The caller returns an empty list instead.
    expect(toMatchQuery(input)).toBeNull()
  })

  it('accepts accented and non-Latin words as words', () => {
    expect(toMatchQuery('facturación')).toBe('"facturación"*')
    expect(toMatchQuery('配送 問題')).toBe('"配送" "問題"*')
  })

  it('caps how much of a query it will act on', () => {
    const many = Array.from({ length: 40 }, (_unused, index) => `term${index}`).join(' ')
    expect(toMatchQuery(many)!.split(' ')).toHaveLength(HELP_SEARCH.maxTokens)

    const long = 'x'.repeat(500)
    expect(toMatchQuery(long)!.length).toBeLessThan(HELP_SEARCH.maxTokenLength + 10)
  })
})

describe('chunk', () => {
  it('splits on headings, because that is the shape the author already gave it', () => {
    const pieces = chunk('Intro paragraph\n\n## First section\nBody\n\n### Nested\nMore')
    expect(pieces).toHaveLength(3)
    expect(pieces[1]).toContain('## First section')
  })

  it('wraps a section that is a wall of prose', () => {
    const paragraph = `${'word '.repeat(150)}\n\n`
    const pieces = chunk(`## Section\n${paragraph.repeat(6)}`)
    expect(pieces.length).toBeGreaterThan(1)
    // A whole article in one vector is a blurred average of everything it says and matches nothing
    // in particular.
    for (const piece of pieces) {
      expect(piece.length).toBeLessThan(2000)
    }
  })

  it('drops nothing and invents nothing for an empty article', () => {
    expect(chunk('')).toEqual([])
    expect(chunk('   \n\n  ')).toEqual([])
  })
})
