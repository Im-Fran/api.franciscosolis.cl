import { describe, expect, it } from 'vitest'
import { escapeHtml, extractVariables, missingVariables, render } from '@/lib/template'

describe('extractVariables', () => {
  it('finds a plain placeholder', () => {
    expect(extractVariables('Hola {{ name }}')).toEqual(['name'])
  })

  it('tolerates any amount of inner whitespace, or none', () => {
    expect(extractVariables('{{name}} {{  name2  }} {{\tname3\t}}')).toEqual(['name', 'name2', 'name3'])
  })

  it('de-duplicates repeats', () => {
    expect(extractVariables('{{ name }} and {{name}} and {{  name  }}')).toEqual(['name'])
  })

  it('keeps first-seen order rather than sorting', () => {
    expect(extractVariables('{{ zebra }} {{ alpha }} {{ zebra }} {{ mid }}')).toEqual(['zebra', 'alpha', 'mid'])
  })

  it('accepts digits and underscores in a name', () => {
    expect(extractVariables('{{ user_name_2 }}')).toEqual(['user_name_2'])
  })

  it('does not match names outside [a-zA-Z0-9_]', () => {
    expect(extractVariables('{{ user-name }}')).toEqual([])
    expect(extractVariables('{{ user.name }}')).toEqual([])
    expect(extractVariables('{{ señor }}')).toEqual([])
    expect(extractVariables('{{ a b }}')).toEqual([])
  })

  it('ignores an unclosed or single-brace placeholder', () => {
    expect(extractVariables('{ name }')).toEqual([])
    expect(extractVariables('{{ name }')).toEqual([])
    expect(extractVariables('{{ name')).toEqual([])
  })

  it('returns nothing for a template with no placeholders', () => {
    expect(extractVariables('Just text.')).toEqual([])
    expect(extractVariables('')).toEqual([])
  })

  it('is not left stateful by the global regex between calls', () => {
    // `PLACEHOLDER` carries the `g` flag and is module state; a stale `lastIndex` would make the
    // second call skip the first match.
    expect(extractVariables('{{ a }}')).toEqual(['a'])
    expect(extractVariables('{{ a }}')).toEqual(['a'])
  })
})

describe('render', () => {
  it('substitutes a value', () => {
    expect(render('Hola {{ name }}', { name: 'Fran' })).toBe('Hola Fran')
  })

  it('substitutes every occurrence, whatever the spacing', () => {
    expect(render('{{name}}-{{ name }}-{{  name  }}', { name: 'x' })).toBe('x-x-x')
  })

  it('replaces a variable with no value by an empty string', () => {
    expect(render('Hola {{ name }}!', {})).toBe('Hola !')
  })

  it('leaves the surrounding text untouched', () => {
    expect(render('a {{ b }} c {{ d }} e', { b: '1', d: '2' })).toBe('a 1 c 2 e')
  })

  it('does not escape the value it inserts', () => {
    // Deliberate: an editor authors the whole HTML body, and escaping here would break their own
    // markup. Callers interpolating untrusted text are expected to run `escapeHtml` first.
    expect(render('<p>{{ body }}</p>', { body: '<b>bold</b>' })).toBe('<p><b>bold</b></p>')
    expect(render('{{ x }}', { x: '<script>alert(1)</script>' })).toBe('<script>alert(1)</script>')
  })

  it('ignores values whose placeholder is not in the template', () => {
    expect(render('Hola {{ name }}', { name: 'Fran', unused: 'ignored' })).toBe('Hola Fran')
  })

  it('inserts an empty string rather than the word undefined', () => {
    expect(render('[{{ missing }}]', { other: 'x' })).toBe('[]')
  })

  it('does not re-expand a placeholder that came from a value', () => {
    // One pass only: a value that looks like a placeholder is inserted literally.
    expect(render('{{ a }}', { a: '{{ b }}', b: 'nested' })).toBe('{{ b }}')
  })
})

describe('missingVariables', () => {
  it('lists the placeholders with no value', () => {
    expect(missingVariables('{{ a }} {{ b }} {{ c }}', { b: 'set' })).toEqual(['a', 'c'])
  })

  it('returns nothing when every placeholder has one', () => {
    expect(missingVariables('{{ a }} {{ b }}', { a: '1', b: '2' })).toEqual([])
  })

  it('counts an empty string as a value, since only `undefined` is missing', () => {
    expect(missingVariables('{{ a }}', { a: '' })).toEqual([])
  })

  it('reports a repeated placeholder once', () => {
    expect(missingVariables('{{ a }} {{ a }}', {})).toEqual(['a'])
  })

  it('returns nothing for a template with no placeholders', () => {
    expect(missingVariables('plain text', {})).toEqual([])
  })
})

describe('escapeHtml', () => {
  it('escapes all five entities', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;')
  })

  it('escapes the ampersand first, so an entity is not double-encoded wrongly', () => {
    expect(escapeHtml('<')).toBe('&lt;')
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })

  it('neutralises a script tag', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    )
  })

  it('escapes every occurrence, not just the first', () => {
    expect(escapeHtml('a<b<c')).toBe('a&lt;b&lt;c')
  })

  it('leaves ordinary text and accents alone', () => {
    expect(escapeHtml('Ingeniería civil — 2026')).toBe('Ingeniería civil — 2026')
    expect(escapeHtml('')).toBe('')
  })
})
