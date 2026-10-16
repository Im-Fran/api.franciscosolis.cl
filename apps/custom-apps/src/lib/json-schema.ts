/**
 * A small JSON Schema validator, for the remote config document an app's schema describes.
 *
 * A subset on purpose, and a strict one: a schema using a keyword this file does not implement is
 * *refused* when it is saved (`checkSchema`), rather than accepted and silently not enforced. A config
 * document is what a client's kiosk reads at start-up, and a constraint that looked enforced but was
 * not is how a typo reaches the fleet.
 *
 * Supported: `type` (one or a list of `object`, `array`, `string`, `number`, `integer`, `boolean`,
 * `null`), `properties`, `required`, `additionalProperties` (boolean or a schema), `items`, `enum`,
 * `const`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `minItems`, `maxItems`, and the
 * annotations `title`, `description`, `default`, `examples` and `$schema`, which constrain nothing.
 */

type Schema = Record<string, unknown>

const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] as const

const KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'title',
  'description',
  'default',
  'examples',
  '$schema',
])

/** Deeper than this is refused: a config schema nested thirty levels down is a mistake. */
const MAX_DEPTH = 32

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isCount = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0

/**
 * The problems with a schema itself, as `path: message` strings. Empty means it can be saved.
 */
const checkSchema = (schema: unknown, path = '#', depth = 0): string[] => {
  if (!isObject(schema)) return [`${path}: a schema must be an object`]
  if (depth > MAX_DEPTH) return [`${path}: nested too deeply`]
  const problems: string[] = []

  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) problems.push(`${path}: the keyword "${key}" is not supported`)
  }

  if ('type' in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (types.length === 0 || !types.every((type) => (TYPES as readonly unknown[]).includes(type))) {
      problems.push(`${path}/type: must be one of ${TYPES.join(', ')}, or a list of them`)
    }
  }
  if ('properties' in schema) {
    if (!isObject(schema.properties)) problems.push(`${path}/properties: must be an object`)
    else {
      for (const [name, child] of Object.entries(schema.properties)) {
        problems.push(...checkSchema(child, `${path}/properties/${name}`, depth + 1))
      }
    }
  }
  if ('required' in schema && !(Array.isArray(schema.required) && schema.required.every((name) => typeof name === 'string'))) {
    problems.push(`${path}/required: must be a list of property names`)
  }
  if ('additionalProperties' in schema && typeof schema.additionalProperties !== 'boolean') {
    problems.push(...checkSchema(schema.additionalProperties, `${path}/additionalProperties`, depth + 1))
  }
  if ('items' in schema) problems.push(...checkSchema(schema.items, `${path}/items`, depth + 1))
  if ('enum' in schema && !(Array.isArray(schema.enum) && schema.enum.length > 0)) {
    problems.push(`${path}/enum: must be a non-empty list`)
  }
  for (const key of ['minimum', 'maximum'] as const) {
    if (key in schema && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) problems.push(`${path}/${key}: must be a number`)
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    if (key in schema && !isCount(schema[key])) problems.push(`${path}/${key}: must be a non-negative integer`)
  }
  if ('pattern' in schema) {
    if (typeof schema.pattern !== 'string') problems.push(`${path}/pattern: must be a string`)
    else {
      try {
        new RegExp(schema.pattern, 'u')
      } catch {
        problems.push(`${path}/pattern: is not a valid regular expression`)
      }
    }
  }
  return problems
}

const typeOf = (value: unknown): (typeof TYPES)[number] => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value as 'object' | 'string' | 'boolean'
}

const matchesType = (value: unknown, type: unknown) => {
  const actual = typeOf(value)
  return actual === type || (type === 'number' && actual === 'integer')
}

/** Structural equality for `enum` and `const`, over JSON values. */
const sameJson = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => sameJson(item, b[index]))
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
  }
  return false
}

/** String length in code points, which is what JSON Schema counts. */
const length = (value: string) => [...value].length

/**
 * The ways `value` fails `schema`, as `path: message` strings. Empty means it is valid. Assumes the
 * schema passed `checkSchema`.
 */
const validateJson = (schema: Schema, value: unknown, path = '#'): string[] => {
  const problems: string[] = []

  if ('type' in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => matchesType(value, type))) {
      return [`${path}: must be ${types.join(' or ')}`]
    }
  }
  if ('const' in schema && !sameJson(value, schema.const)) problems.push(`${path}: must be ${JSON.stringify(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameJson(value, option))) {
    problems.push(`${path}: must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`)
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) problems.push(`${path}: must be at least ${schema.minimum}`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) problems.push(`${path}: must be at most ${schema.maximum}`)
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && length(value) < schema.minLength) problems.push(`${path}: must be at least ${schema.minLength} characters`)
    if (typeof schema.maxLength === 'number' && length(value) > schema.maxLength) problems.push(`${path}: must be at most ${schema.maxLength} characters`)
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) problems.push(`${path}: must match ${schema.pattern}`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) problems.push(`${path}: must have at least ${schema.minItems} items`)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) problems.push(`${path}: must have at most ${schema.maxItems} items`)
    if (isObject(schema.items)) {
      value.forEach((item, index) => problems.push(...validateJson(schema.items as Schema, item, `${path}/${index}`)))
    }
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {}
    if (Array.isArray(schema.required)) {
      for (const name of schema.required as string[]) {
        if (!Object.hasOwn(value, name)) problems.push(`${path}: is missing the required property "${name}"`)
      }
    }
    for (const [name, child] of Object.entries(value)) {
      const childPath = `${path}/${name}`
      if (Object.hasOwn(properties, name)) {
        problems.push(...validateJson(properties[name] as Schema, child, childPath))
      } else if (schema.additionalProperties === false) {
        problems.push(`${childPath}: is not an allowed property`)
      } else if (isObject(schema.additionalProperties)) {
        problems.push(...validateJson(schema.additionalProperties, child, childPath))
      }
    }
  }
  return problems
}

export { checkSchema, validateJson }
export type { Schema }
