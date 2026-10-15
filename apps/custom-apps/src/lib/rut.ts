/**
 * Chilean RUT (Rol Único Tributario): a body of up to eight digits and a check digit computed with
 * the modulo-11 algorithm, where 10 is written `K` and 11 is written `0`.
 *
 * Stored in one canonical form, `12345678-5` — no thousands dots, uppercase `K` — because the same
 * RUT typed as `12.345.678-5`, `12345678-5` and `123456785` must collide on the unique index rather
 * than become three clients.
 */

/** The check digit a RUT body should carry. */
const checkDigit = (body: string): string => {
  let sum = 0
  let factor = 2
  for (let index = body.length - 1; index >= 0; index -= 1) {
    sum += Number(body[index]) * factor
    factor = factor === 7 ? 2 : factor + 1
  }
  const remainder = 11 - (sum % 11)
  if (remainder === 11) return '0'
  if (remainder === 10) return 'K'
  return String(remainder)
}

/**
 * The canonical form of a RUT, or null when the input is not one: wrong shape, or a check digit
 * that does not match its body. Accepts dots, spaces, an optional dash and a lowercase `k`.
 */
const normalizeRut = (input: string): string | null => {
  const compact = input.replace(/[.\s-]/g, '').toUpperCase()
  const match = /^(\d{1,8})([0-9K])$/.exec(compact)
  if (!match) {
    return null
  }
  const body = match[1]!.replace(/^0+(?=\d)/, '')
  const digit = match[2]!
  if (Number(body) === 0 || checkDigit(body) !== digit) {
    return null
  }
  return `${body}-${digit}`
}

export { checkDigit, normalizeRut }
