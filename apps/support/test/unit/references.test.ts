import { describe, expect, it } from 'vitest'
import { findReferenceInSubject, formatReference, parseReference, stripReferenceTag } from '@/lib/references'

describe('formatReference', () => {
  it('renders the prefixed form people read out loud', () => {
    expect(formatReference(1042)).toBe('FS-1042')
  })
})

describe('parseReference', () => {
  it.each([
    ['the prefixed form', 'FS-1042', 1042],
    ['a lowercase prefix, because people type it', 'fs-1042', 1042],
    ['a bare number, because people paste it', '1042', 1042],
    ['surrounding whitespace', '  FS-1042  ', 1042],
  ])('accepts %s', (_label, input, expected) => {
    expect(parseReference(input)).toBe(expected)
  })

  it.each([
    ['an empty string', ''],
    ['a different prefix', 'XX-1042'],
    ['a UUID', 'b7b9e0f4-2b45-4a71-9d1a-7d5a0e6c1f22'],
    ['zero, which no ticket ever has', '0'],
    ['a negative number', '-5'],
    ['something absurdly long', '1'.repeat(40)],
    ['an injection attempt', "1042'; DROP TABLE tickets;--"],
  ])('refuses %s', (_label, input) => {
    expect(parseReference(input)).toBeNull()
  })
})

describe('findReferenceInSubject', () => {
  it('finds the tag in a reply subject', () => {
    expect(findReferenceInSubject('Re: [FS-1042] Cannot sign in')).toBe(1042)
  })

  it('finds it wherever the mail client put it', () => {
    expect(findReferenceInSubject('RE: RV: Cannot sign in [FS-7]')).toBe(7)
  })

  it.each([
    ['a subject with no tag', 'Cannot sign in'],
    ['a bare reference that is not a tag', 'FS-1042 is my ticket'],
    ['nothing at all', null],
    ['undefined', undefined],
  ])('returns null for %s', (_label, subject) => {
    expect(findReferenceInSubject(subject)).toBeNull()
  })
})

describe('stripReferenceTag', () => {
  it.each([
    ['a tagged reply', 'Re: [FS-1042] Cannot sign in', 'Cannot sign in'],
    ['a forward', 'Fwd: Cannot sign in', 'Cannot sign in'],
    ['a Spanish forward prefix', 'RV: [FS-7] No puedo entrar', 'No puedo entrar'],
    ['several tags a long thread accumulated', '[FS-1] [FS-2] Cannot sign in', 'Cannot sign in'],
    ['a subject that needs nothing done to it', 'Cannot sign in', 'Cannot sign in'],
  ])('cleans %s', (_label, subject, expected) => {
    // A new ticket built from an email whose subject already carries a tag would otherwise be
    // announced as `[FS-1002] [FS-9999] Cannot sign in`.
    expect(stripReferenceTag(subject)).toBe(expected)
  })
})
