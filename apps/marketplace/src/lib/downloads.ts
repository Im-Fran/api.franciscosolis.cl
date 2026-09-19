import type { Env } from '@/env'

/**
 * The download tickets `GET /downloads/:ticket` serves bytes against.
 *
 * **Why a Worker serves the bytes at all.** The obvious arrangement — a public bucket, or a presigned
 * R2 URL handed to the browser — cannot express any of what this feature is: whether the product
 * is paid, whether *this* account paid for it, and whether the download starts now or in five
 * seconds. A URL that carries its own permission cannot be asked those questions, so the download
 * goes through code that can.
 *
 * **Why the ticket is signed rather than stored.** A row per click would be a D1 write on the hot
 * path of a file download, and a second one to mark it used. The ticket instead carries what it
 * grants and is verified by recomputing its signature — the same trade `apps/auth` makes for an
 * access token, and for the same reason. Nothing is revocable, which is why a ticket lives minutes
 * rather than hours: the thing being protected is a build, and the short window is the whole
 * mitigation for a shared link.
 *
 * **`nbf` is the cooldown.** A non-payer's ticket is minted five seconds in the future, so the wait
 * is a property of the credential rather than a `setTimeout` on a page anyone can skip past with the
 * dev tools. A payer's ticket starts immediately. That is the entire difference between the two,
 * and it is enforced here rather than in the front-end.
 */

/** Ticket lifetime, in seconds. Long enough to start a download, short enough to be worth sharing. */
const TICKET_TTL = 300

/** What a non-payer waits before their download begins, in seconds. */
const COOLDOWN_SECONDS = 5

/** Claims a ticket carries. Short keys because the whole thing travels in a path segment. */
type DownloadTicket = {
  /** File the ticket is for. A ticket for another file is a ticket for another file. */
  f: string
  /** Product the file belongs to, so the serving route can check the pair without a join. */
  a: string
  /** Account the ticket was minted for, or null for an anonymous download. */
  u: string | null
  /** Purchase it was granted against, when there was one. */
  p: string | null
  /**
   * Channel the build came from, so the serving route can log which line it was without a second
   * read. Not a trust boundary: the gate was decided when the ticket was minted, and a ticket
   * naming a channel it was not minted for would have to be forged past the signature first.
   */
  c: string
  /** Whether this download is a paid one — what decides the cooldown and what is logged. */
  paid: boolean
  /** Unix seconds before which the bytes are not served. The cooldown. */
  nbf: number
  exp: number
}

/** Why a ticket was refused. The route maps each to its own status, so they stay distinguishable. */
type TicketFailure = 'malformed' | 'signature' | 'expired' | 'early'

class DownloadTicketError extends Error {
  readonly reason: TicketFailure

  constructor(reason: TicketFailure, message: string) {
    super(message)
    this.name = 'DownloadTicketError'
    this.reason = reason
  }
}

const encoder = new TextEncoder()

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

/**
 * Per-isolate HMAC key cache, keyed by the secret it was imported from so a rotated
 * `DOWNLOAD_SIGNING_KEY` is picked up without waiting for the isolate to be recycled.
 */
let cachedKey: { secret: string; key: CryptoKey } | null = null

const signingKey = async (env: Env): Promise<CryptoKey> => {
  const secret = env.DOWNLOAD_SIGNING_KEY
  if (!secret) {
    // Left unconfigured this Worker would happily mint tickets anybody could forge, so it refuses to
    // mint any. A 500 here reads as "downloads are not set up", which is what it is.
    throw new Error('DOWNLOAD_SIGNING_KEY is not configured, so no download ticket can be signed')
  }
  if (cachedKey?.secret === secret) {
    return cachedKey.key
  }

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  cachedKey = { secret, key }
  return key
}

/** Signs a ticket into `<payload>.<signature>`, both base64url. */
const mintDownloadTicket = async (
  env: Env,
  input: Omit<DownloadTicket, 'nbf' | 'exp'> & { cooldownSeconds?: number },
): Promise<{ ticket: string; availableAt: Date; expiresAt: Date }> => {
  const now = Math.floor(Date.now() / 1000)
  const cooldown = input.cooldownSeconds ?? (input.paid ? 0 : COOLDOWN_SECONDS)

  const claims: DownloadTicket = {
    f: input.f,
    a: input.a,
    u: input.u,
    p: input.p,
    c: input.c,
    paid: input.paid,
    nbf: now + cooldown,
    // Measured from the moment the ticket becomes usable, so a cooldown never eats into the window.
    exp: now + cooldown + TICKET_TTL,
  }

  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)))
  const signature = await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode(payload))

  return {
    ticket: `${payload}.${toBase64Url(new Uint8Array(signature))}`,
    availableAt: new Date(claims.nbf * 1000),
    expiresAt: new Date(claims.exp * 1000),
  }
}

/**
 * Verifies a ticket and returns its claims, throwing a `DownloadTicketError` on anything wrong.
 *
 * The order matters: the signature is checked before the timestamps, so an expired *forgery* is
 * reported as a forgery. `crypto.subtle.verify` is what does the comparison, which keeps the
 * constant-time question out of this file entirely.
 */
const verifyDownloadTicket = async (env: Env, ticket: string): Promise<DownloadTicket> => {
  const [payload, signature] = ticket.split('.')
  if (!payload || !signature) {
    throw new DownloadTicketError('malformed', 'The download link is malformed')
  }

  let valid: boolean
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await signingKey(env),
      fromBase64Url(signature),
      encoder.encode(payload),
    )
  } catch {
    throw new DownloadTicketError('malformed', 'The download link is malformed')
  }
  if (!valid) {
    throw new DownloadTicketError('signature', 'The download link is not valid')
  }

  let claims: DownloadTicket
  try {
    claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as DownloadTicket
  } catch {
    throw new DownloadTicketError('malformed', 'The download link is malformed')
  }
  if (typeof claims.f !== 'string' || typeof claims.a !== 'string' || typeof claims.exp !== 'number') {
    throw new DownloadTicketError('malformed', 'The download link is malformed')
  }

  const now = Math.floor(Date.now() / 1000)
  if (claims.exp <= now) {
    throw new DownloadTicketError('expired', 'The download link has expired; ask for a new one')
  }
  if (claims.nbf > now) {
    throw new DownloadTicketError('early', `The download starts in ${claims.nbf - now} seconds`)
  }

  return claims
}

export {
  COOLDOWN_SECONDS,
  DownloadTicketError,
  mintDownloadTicket,
  TICKET_TTL,
  verifyDownloadTicket,
}
export type { DownloadTicket, TicketFailure }
