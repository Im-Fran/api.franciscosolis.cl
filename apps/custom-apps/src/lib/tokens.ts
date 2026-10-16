/**
 * Opaque credentials: the app keys client apps enroll with, and the access and refresh tokens an
 * installation holds afterwards.
 *
 * Opaque rather than signed, because every request already reads the installation's row (to update
 * its presence), and a row lookup is what makes revocation immediate — a signed token would stay
 * valid until it expired, whatever the panel said. Only the SHA-256 of a device token is stored, so a
 * leaked copy of the database cannot impersonate a device; the app key is the exception, being public.
 *
 * The prefixes make a credential recognisable in a log or a support message, and tell a secret
 * scanner what it found: `cak_` an app key, `cat_` an access token, `car_` a refresh token.
 */

const TOKEN_PREFIXES = {
  appKey: 'cak_',
  access: 'cat_',
  refresh: 'car_',
} as const

const base64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A prefixed random credential carrying `bytes` of entropy. */
const randomToken = (prefix: string, bytes = 32): string => {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return `${prefix}${base64Url(buffer)}`
}

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

/** SHA-256 of a credential, hex-encoded. What the database holds instead of the token. */
const hashToken = async (token: string): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))

/** The value of a Subresource Integrity attribute for `content`. */
const sriSha384 = async (content: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-384', new TextEncoder().encode(content)))
  let binary = ''
  for (const byte of digest) {
    binary += String.fromCharCode(byte)
  }
  return `sha384-${btoa(binary)}`
}

export { base64Url, hashToken, randomToken, sriSha384, TOKEN_PREFIXES }
