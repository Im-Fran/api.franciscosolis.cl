import { RELEASES } from '@/lib/config'

/**
 * The tickets a device downloads a release artifact against, at `GET /:appId/downloads/:ticket`.
 *
 * **Why a ticket, and not the bearer token.** What fetches the bytes is often not the app's own HTTP
 * client: Android's DownloadManager, a package installer, a resumable downloader on a kiosk. Those
 * cannot be relied on to carry an `Authorization` header, so the device trades its token for a link
 * that carries its own short-lived permission — the "URL firmada y de corta duración" of the plan.
 *
 * **Why signed rather than stored.** A row per download would be a D1 write on the path of every
 * update. The ticket names what it grants and is verified by recomputing its signature, the same
 * trade the marketplace makes for its builds. Nothing is revocable, which is why it lives minutes.
 */

type DownloadTicket = {
  /** Release. */
  r: string
  /** App, so a ticket used under another app's path is refused without a read. */
  a: string
  /** Installation it was minted for, for the logs. */
  i: string
  exp: number
}

const encoder = new TextEncoder()

const toBase64Url = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (value: string) => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}

/** Per-isolate key cache, keyed by the secret so a rotation is picked up without a recycle. */
let cached: { secret: string; key: CryptoKey } | null = null

const keyFor = async (secret: string) => {
  if (cached?.secret === secret) return cached.key
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  cached = { secret, key }
  return key
}

const mintDownloadTicket = async (secret: string, claims: Omit<DownloadTicket, 'exp'>, now: Date = new Date()) => {
  const exp = Math.floor(now.getTime() / 1000) + RELEASES.downloadTtlSeconds
  const payload = toBase64Url(encoder.encode(JSON.stringify({ ...claims, exp } satisfies DownloadTicket)))
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await keyFor(secret), encoder.encode(payload)))
  return { ticket: `${payload}.${toBase64Url(signature)}`, expiresAt: new Date(exp * 1000) }
}

/**
 * The claims of a valid, unexpired ticket, or null. Every failure is the same null on purpose: a
 * malformed, forged or expired link earns the same 404, and the device's recovery is the same —
 * ask for a new one.
 */
const verifyDownloadTicket = async (secret: string, ticket: string, now: Date = new Date()): Promise<DownloadTicket | null> => {
  const [payload, signature] = ticket.split('.')
  if (!payload || !signature) return null
  try {
    const valid = await crypto.subtle.verify('HMAC', await keyFor(secret), fromBase64Url(signature), encoder.encode(payload))
    if (!valid) return null
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as DownloadTicket
    if (typeof claims.r !== 'string' || typeof claims.a !== 'string' || typeof claims.exp !== 'number') return null
    return claims.exp > Math.floor(now.getTime() / 1000) ? claims : null
  } catch {
    return null
  }
}

export { mintDownloadTicket, verifyDownloadTicket }
export type { DownloadTicket }
