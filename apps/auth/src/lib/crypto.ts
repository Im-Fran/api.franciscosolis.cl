/** Base64url alphabet, no padding — the encoding every token in this Worker uses. */
const base64UrlEncode = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const base64UrlDecode = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

const generateId = (): string => crypto.randomUUID()

/**
 * Cryptographically random opaque token. 32 bytes = 256 bits of entropy, which is what magic link
 * tokens, authorization codes and refresh tokens all rely on for unguessability.
 */
const randomToken = (bytes = 32): string => base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)))

/** SHA-256 of a UTF-8 string, base64url encoded. Every token is persisted as this, never raw. */
const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return base64UrlEncode(digest)
}

/**
 * Length-independent constant-time string comparison, used for secrets we compare in-process
 * (client secrets, PKCE challenges) so a mismatch cannot be located byte by byte through timing.
 */
const timingSafeEqual = (a: string, b: string): boolean => {
  const left = new TextEncoder().encode(a)
  const right = new TextEncoder().encode(b)
  // The length itself is not secret, but bail out only after a fixed-cost comparison over the
  // longer input so the loop below always runs the same number of iterations for a given `a`.
  const length = Math.max(left.length, right.length)
  let diff = left.length ^ right.length
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0)
  }
  return diff === 0
}

export { base64UrlDecode, base64UrlEncode, generateId, randomToken, sha256, timingSafeEqual }
