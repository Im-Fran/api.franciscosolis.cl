import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import {
  COMPATIBILITY_KIND_INFO,
  COMPATIBILITY_KINDS,
  compatibilitySchema,
  isCompatibilityKind,
  toPublicCompatibility,
} from '@/lib/compatibility'

const parse = (input: unknown) => v.safeParse(compatibilitySchema, input)

describe('the compatibility vocabulary', () => {
  it('is closed, and every kind carries a fallback label', () => {
    expect(isCompatibilityKind('os')).toBe(true)
    expect(isCompatibilityKind('vibes')).toBe(false)
    for (const kind of COMPATIBILITY_KINDS) {
      expect(COMPATIBILITY_KIND_INFO[kind].name.length).toBeGreaterThan(0)
    }
  })
})

describe('compatibilitySchema', () => {
  it('accepts a requirement with a free-text constraint', () => {
    expect(parse({ kind: 'os', name: 'macOS', constraint: '>= 14.0' }).success).toBe(true)
  })

  /**
   * The constraint is deliberately not parsed. This Worker fronts a Minecraft plugin and a mobile
   * app equally well, exactly as a version label does, and a comparison that is right nine times in
   * ten is worse than none.
   */
  it.each(['>= 14.0', '17+', '1.20–1.21', '2026.1', 'any'])('takes %s as a constraint verbatim', (constraint) => {
    const result = parse({ kind: 'runtime', name: 'Java', constraint })
    expect(result.success).toBe(true)
    expect(result.success && result.output.constraint).toBe(constraint)
  })

  it('refuses a kind outside the vocabulary', () => {
    expect(parse({ kind: 'vibes', name: 'Good ones' }).success).toBe(false)
  })

  /** Strict, like `linkSchema`: a misspelled field must be a 422, not a requirement that says nothing. */
  it('refuses a misspelled field rather than dropping it', () => {
    expect(parse({ kind: 'os', name: 'macOS', constrain: '>= 14.0' }).success).toBe(false)
  })

  it('refuses an empty name', () => {
    expect(parse({ kind: 'os', name: '   ' }).success).toBe(false)
  })
})

describe('toPublicCompatibility', () => {
  const row = {
    id: 'entry-1',
    kind: 'runtime',
    name: 'Java',
    constraintText: '17+',
    optional: false,
    position: 2,
  }

  /** The column is `constraint_text` because `CONSTRAINT` is reserved; the API field is `constraint`. */
  it('maps the reserved-word column back onto the API field', () => {
    expect(toPublicCompatibility(row)).toEqual({
      id: 'entry-1',
      kind: 'runtime',
      name: 'Java',
      constraint: '17+',
      optional: false,
      position: 2,
    })
  })

  it('degrades a retired kind to `other` rather than serializing something unknown', () => {
    expect(toPublicCompatibility({ ...row, kind: 'quantum' }).kind).toBe('other')
  })
})
