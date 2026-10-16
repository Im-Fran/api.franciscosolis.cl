import { describe, expect, it } from 'vitest'
import { checkSchema, validateJson } from '@/lib/json-schema'

describe('the remote config schema', () => {
  it('refuses keywords it cannot enforce, rather than ignoring them', () => {
    expect(checkSchema({ type: 'object', properties: { a: { type: 'string', format: 'email' } } })).toEqual(['#/properties/a: the keyword "format" is not supported'])
    expect(checkSchema({ anyOf: [] })).toEqual(['#: the keyword "anyOf" is not supported'])
    expect(checkSchema({ type: 'text' })).toHaveLength(1)
    expect(checkSchema({ pattern: '([' })).toEqual(['#/pattern: is not a valid regular expression'])
    expect(checkSchema({ minLength: -1, enum: [] })).toHaveLength(2)
    expect(checkSchema([])).toEqual(['#: a schema must be an object'])
  })

  it('accepts the subset it implements, annotations included', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'POS',
      type: 'object',
      required: ['currency'],
      additionalProperties: false,
      properties: {
        currency: { enum: ['CLP', 'UF'], default: 'CLP' },
        printers: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', pattern: '^COM\\d+$' } },
        tip: { type: ['integer', 'null'], minimum: 0, maximum: 30 },
        mode: { const: 'kiosk' },
        labels: { type: 'object', additionalProperties: { type: 'string', maxLength: 20 } },
      },
    }
    expect(checkSchema(schema)).toEqual([])
    expect(validateJson(schema, { currency: 'CLP', printers: ['COM3'], tip: null, mode: 'kiosk', labels: { a: 'b' } })).toEqual([])
    expect(validateJson(schema, { printers: [], tip: 1.5, mode: 'pos', labels: { a: 'x'.repeat(21) }, extra: 1 })).toEqual([
      '#: is missing the required property "currency"',
      '#/printers: must have at least 1 items',
      '#/tip: must be integer or null',
      '#/mode: must be "kiosk"',
      '#/labels/a: must be at most 20 characters',
      '#/extra: is not an allowed property',
    ])
    expect(validateJson(schema, { currency: 'CLP', printers: ['LPT1'] })).toEqual(['#/printers/0: must match ^COM\\d+$'])
  })

  it('treats an integer as a number, and counts characters rather than bytes', () => {
    expect(validateJson({ type: 'number' }, 3)).toEqual([])
    expect(validateJson({ type: 'integer' }, 3.5)).toEqual(['#: must be integer'])
    expect(validateJson({ type: 'string', maxLength: 4 }, 'ñandú')).toEqual(['#: must be at most 4 characters'])
    expect(validateJson({ type: 'string', maxLength: 5 }, 'ñandú')).toEqual([])
  })

  it('compares enums and consts structurally', () => {
    expect(validateJson({ enum: [{ a: [1, 2] }] }, { a: [1, 2] })).toEqual([])
    expect(validateJson({ const: { a: 1 } }, { a: 1, b: 2 })).toHaveLength(1)
  })
})
