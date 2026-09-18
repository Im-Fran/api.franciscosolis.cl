/**
 * The two per-ticket secrets, and the hashing they are stored behind.
 *
 * `apps/auth` established the rule this follows: anything a person holds is written to the database
 * only as a SHA-256 hash, so a dump of the table hands an attacker nothing they can present. The
 * same rule applies here, with one extra property — the hash column is *uniquely indexed*, so
 * resolving a ticket from a token is a single index probe on a 256-bit value rather than a fetch
 * followed by a comparison. That is not just faster: a fetch-then-compare would need a constant-time
 * equality check to avoid leaking the secret a byte at a time through timing, and an index lookup
 * sidesteps the question entirely.
 */

/** Bytes of entropy in a generated secret. 256 bits, the same order as a session id in `apps/auth`. */
const SECRET_BYTES = 32

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A fresh URL-safe secret. Used for both the access token and the reply key. */
const generateSecret = (): string => toBase64Url(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)))

/** Lowercase hex SHA-256. The stored form of every secret in this Worker. */
const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The link emailed to a requester.
 *
 * The secret rides in the **fragment**, not the query string. A fragment is never sent to a server:
 * it stays out of access logs, out of the `Referer` header of every outbound link the page renders,
 * and out of anything sitting between the browser and the origin. The front-end reads it once,
 * strips it with `history.replaceState` and keeps it in `sessionStorage` from then on.
 *
 * The API still accepts `?token=` as a documented convenience for curl and for tests. That is a
 * deliberate, narrow exception — nothing this Worker *generates* ever puts a secret in a query.
 */
const buildTicketUrl = (baseUrl: string, reference: string, secret: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/${reference}#k=${secret}`

/**
 * The envelope address a reply comes back to, carrying the ticket's routing key.
 *
 * This is the strongest threading signal available: we minted the key, it is 256 bits, and it sits
 * in the address the recipient's mail client fills in automatically when they press reply. It is
 * deliberately a *different* secret from the access token — this one is baked into every message
 * ever sent about the ticket and can never be rotated without breaking those reply buttons, while
 * the access token has to be rotatable the day somebody forwards their link to the wrong person.
 */
const buildReplyAddress = (replyDomain: string, replyKey: string): string =>
  `reply+${replyKey}@${replyDomain}`

/** Pulls the routing key back out of a `reply+<key>@domain` address. Null when it is not one. */
const parseReplyAddress = (address: string): string | null => {
  const match = /^reply\+([A-Za-z0-9_-]+)@/.exec(address.trim().toLowerCase())
  return match?.[1] ?? null
}

export { buildReplyAddress, buildTicketUrl, generateSecret, parseReplyAddress, sha256 }
