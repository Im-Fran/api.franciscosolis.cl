import { describe, expect, it } from 'vitest'
import { htmlToText, readBody, trimQuotedReply } from '@/lib/mime'

describe('htmlToText', () => {
  it('keeps the words and drops the markup', () => {
    expect(htmlToText('<p>Hello <b>there</b></p><p>Second line</p>')).toBe('Hello there\n\nSecond line')
  })

  it('turns line breaks and list items into something readable', () => {
    expect(htmlToText('One<br>Two<ul><li>a</li><li>b</li></ul>')).toBe('One\nTwo\n- a\n- b')
  })

  it('throws away script and style contents rather than rendering them as text', () => {
    const html = '<style>.x{color:red}</style><p>Body</p><script>alert(1)</script>'
    const text = htmlToText(html)
    expect(text).toBe('Body')
    expect(text).not.toContain('alert')
  })

  it('decodes the entities a mail client actually emits', () => {
    expect(htmlToText('<p>Tom &amp; Jerry &lt;3 &nbsp;caf&#233; &#x00E9;</p>')).toBe('Tom & Jerry <3  café é')
  })

  it('never leaves a tag behind for something downstream to render', () => {
    // The schema has no column for HTML, and this is the function that guarantees it never needs one.
    expect(htmlToText('<img src=x onerror="alert(1)"><a href="#">link</a>')).toBe('link')
  })
})

describe('trimQuotedReply', () => {
  it.each([
    [
      'a Gmail attribution line',
      'Thanks, that worked.\n\nOn Tue, 3 Jan 2026 at 14:02, Support <soporte@franciscosolis.cl> wrote:\n> Have you tried…',
    ],
    [
      'the same in Spanish',
      'Gracias, ya funciona.\n\nEl 3 ene 2026, a las 14:02, Soporte <soporte@franciscosolis.cl> escribió:\n> ¿Probaste…',
    ],
    ['an Outlook separator', 'Thanks, that worked.\n\n________________________________\nFrom: Support\nSent: Tuesday'],
    ['an Outlook header block', 'Thanks, that worked.\n\nFrom: Support\nSent: Tuesday 3 January\nTo: me'],
    ['the original-message marker', 'Thanks, that worked.\n\n-----Original Message-----\nFrom: Support'],
    ['a signature delimiter', 'Thanks, that worked.\n\n-- \nSomebody\nSenior Something'],
  ])('cuts at %s', (_label, input) => {
    // Without this the thread grows quadratically: message n carries all of 1..n-1, every digest
    // quotes the whole history back, and an agent reads the same paragraph nine times.
    expect(trimQuotedReply(input).split('\n')[0]).toMatch(/^(Thanks|Gracias)/)
    expect(trimQuotedReply(input)).not.toContain('From:')
    expect(trimQuotedReply(input)).not.toContain('escribió')
  })

  it('cuts a trailing run of quoted lines with no attribution at all', () => {
    expect(trimQuotedReply('Still broken.\n\n> Have you tried turning it off\n> and on again')).toBe('Still broken.')
  })

  it('leaves a quote in the middle of a message alone', () => {
    const input = 'You said:\n\n> restart the service\n\nI did that and it still fails.'
    expect(trimQuotedReply(input)).toBe(input)
  })

  it('returns the original when a message is nothing but quoted text', () => {
    // An empty ticket entry is worse than a redundant one, and a forward with no comment is still
    // somebody telling us something.
    const input = '> the whole message\n> and nothing else'
    expect(trimQuotedReply(input)).toBe(input)
  })

  it('takes the earliest marker when a message carries several', () => {
    const input = 'Short answer.\n\n-- \nSig\n\nOn Tue someone wrote:\n> old'
    expect(trimQuotedReply(input)).toBe('Short answer.')
  })
})

describe('readBody', () => {
  it('prefers the text part', () => {
    expect(readBody({ text: 'Plain', html: '<p>Rich</p>' }).text).toBe('Plain')
  })

  it('falls back to converting the HTML part', () => {
    expect(readBody({ text: '', html: '<p>Only HTML</p>' }).text).toBe('Only HTML')
  })

  it('keeps the untrimmed original only when something was actually cut', () => {
    expect(readBody({ text: 'Nothing to cut' }).raw).toBeNull()

    const quoted = readBody({ text: 'Answer.\n\n-- \nSignature' })
    expect(quoted.text).toBe('Answer.')
    // Kept so a trim that took too much is recoverable, which is the only reason it is safe to be
    // aggressive about trimming at all.
    expect(quoted.raw).toContain('Signature')
  })

  it('caps a body that would not fit', () => {
    const huge = 'x'.repeat(200_000)
    const result = readBody({ text: huge })
    expect(result.text.length).toBeLessThan(huge.length)
    expect(result.text.endsWith('[truncated]')).toBe(true)
  })
})
