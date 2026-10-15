import { describe, expect, it } from 'vitest'
import { checkDigit, normalizeRut } from '@/lib/rut'

describe('the RUT check digit', () => {
  it.each([
    ['12345678', '5'],
    ['11111111', '1'],
    ['76086428', '5'],
    ['99500840', '8'],
  ])('is %s → %s', (body, digit) => {
    expect(checkDigit(body)).toBe(digit)
  })

  it('writes 10 as K', () => {
    expect(checkDigit('10000013')).toBe('K')
    expect(checkDigit('6')).toBe('K')
  })
})

describe('normalizing a RUT', () => {
  it.each(['12.345.678-5', '12345678-5', '123456785', ' 12 345 678 - 5 '])('accepts %j as the same RUT', (input) => {
    expect(normalizeRut(input)).toBe('12345678-5')
  })

  it('uppercases a K so the unique index sees one RUT', () => {
    expect(normalizeRut('76.354.771-k')).toBe('76354771-K')
  })

  it('drops leading zeros', () => {
    expect(normalizeRut('06-K')).toBe('6-K')
  })

  it.each(['12.345.678-4', '123456789-5', 'abc', '', '0-0', '12345678-X'])('refuses %j', (input) => {
    expect(normalizeRut(input)).toBeNull()
  })
})
