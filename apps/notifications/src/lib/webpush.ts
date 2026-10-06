/**
 * Web Push, written against WebCrypto rather than pulled in as a dependency.
 *
 * The `web-push` package every tutorial reaches for is built on Node's `crypto` and `https`, which
 * is the same reason `apps/marketplace` talks to MercadoPago over plain `fetch`: a dependency that
 * assumes Node is a dependency that half-works under `nodejs_compat`. What the protocol actually
 * needs is small and entirely in WebCrypto — ECDH and ECDSA on P-256, HMAC-SHA-256 and AES-128-GCM —
 * so it is the two RFCs, implemented once, here:
 *
 * - **RFC 8292 (VAPID)**: every request carries an ES256 JWT naming the push service's origin, signed
 *   with our key pair, plus the public half. It is how a push service knows the sender is the one the
 *   browser subscribed to — a subscription is bound to the public key it was created with.
 * - **RFC 8291 (message encryption)**: the payload is encrypted to the browser, with the key and
 *   secret it handed over when it subscribed. The push service relays bytes it cannot read.
 *
 * `test/unit/webpush.test.ts` decrypts what this produces the way a browser would, which is the only
 * test of an encryption routine that means anything.
 */

const encoder = new TextEncoder()

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (value: string): Uint8Array => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const hmac = async (key: Uint8Array, data: Uint8Array): Promise<Uint8Array> => {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, data))
}

/**
 * HKDF with a single output block, which is all RFC 8291 ever asks for (32 bytes at most). Written
 * out as extract-then-expand rather than through `crypto.subtle.deriveBits('HKDF')` because the
 * spec is phrased in exactly these HMAC steps, and matching it line for line is what makes it
 * reviewable against the RFC.
 */
const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) => {
  const prk = await hmac(salt, ikm)
  const okm = await hmac(prk, concat(info, new Uint8Array([1])))
  return okm.slice(0, length)
}

type VapidKeys = {
  /** Uncompressed P-256 point, base64url: what the browser's `applicationServerKey` wants. */
  publicKey: string
  privateKey: CryptoKey
}

/**
 * Reads the `VAPID_PRIVATE_KEY` secret: a P-256 private JWK. The public key is rebuilt from its
 * `x`/`y`, which is why the secret is the only configuration push needs.
 *
 * Returns null for a missing or malformed secret rather than throwing, because "push is not
 * configured" is a state this Worker runs in on purpose — locally, and before the secret is set.
 */
const loadVapidKeys = async (secret: string | undefined): Promise<VapidKeys | null> => {
  if (!secret) {
    return null
  }
  try {
    const jwk = JSON.parse(secret) as JsonWebKey
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) {
      return null
    }
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )
    const publicKey = toBase64Url(concat(new Uint8Array([4]), fromBase64Url(jwk.x), fromBase64Url(jwk.y)))
    return { publicKey, privateKey }
  } catch {
    return null
  }
}

/**
 * The `Authorization: vapid t=…, k=…` header for one push service.
 *
 * `aud` is the push service's origin, not the full endpoint: the token is per service, which is
 * what RFC 8292 §2 requires and what lets one token cover every subscription on it. WebCrypto's
 * ECDSA signature is already the raw `r || s` JOSE expects, so no DER unwrapping is needed.
 */
const vapidAuthorization = async (
  keys: VapidKeys,
  endpoint: string,
  subject: string,
  lifetimeSeconds: number,
  now: Date = new Date(),
): Promise<string> => {
  const header = toBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const payload = toBase64Url(
    encoder.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now.getTime() / 1000) + lifetimeSeconds,
        sub: subject,
      }),
    ),
  )
  const signingInput = `${header}.${payload}`
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, encoder.encode(signingInput)),
  )
  return `vapid t=${signingInput}.${toBase64Url(signature)}, k=${keys.publicKey}`
}

/**
 * The ECDH parameters. `@cloudflare/workers-types` spells the peer key `$public` — `public` is a
 * reserved word in the generator that produces it — while the runtime, like the WebCrypto spec,
 * reads `public`. The object is the spec's; only its type is borrowed.
 */
const ecdh = (peer: CryptoKey) => ({ name: 'ECDH', public: peer }) as unknown as SubtleCryptoDeriveKeyAlgorithm

/** One record, as RFC 8188 counts them. Every payload here fits in one, far below this. */
const RECORD_SIZE = 4096

/**
 * Encrypts `plaintext` to a browser, as the `aes128gcm` content coding (RFC 8291 §3–4).
 *
 * A fresh ephemeral key pair and salt per message, so no two messages share a content key even to
 * the same browser. The result is the whole request body: the RFC 8188 header (salt, record size,
 * the ephemeral public key as `keyid`) followed by the single record.
 */
const encryptPayload = async (
  subscription: { p256dh: string; auth: string },
  plaintext: Uint8Array,
): Promise<Uint8Array> => {
  const uaPublic = fromBase64Url(subscription.p256dh)
  const authSecret = fromBase64Url(subscription.auth)

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ephemeral = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', ephemeral.publicKey)) as ArrayBuffer)
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdh(uaKey), ephemeral.privateKey, 256))

  // §3.3: mix the browser's auth secret into the shared secret.
  const keyInfo = concat(encoder.encode('WebPush: info\0'), uaPublic, asPublic)
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32)

  // §3.4 / RFC 8188 §2.2–2.3: the content key and nonce, from a per-message salt.
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12)

  // A single record, so it is also the last one: the plaintext is followed by the 0x02 delimiter
  // and no padding.
  const key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt'])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, new Uint8Array([2]))),
  )

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE)
  header[20] = asPublic.length
  header.set(asPublic, 21)
  return concat(header, ciphertext)
}

type PushTarget = {
  endpoint: string
  p256dh: string
  auth: string
}

type PushOptions = {
  ttl: number
  subject: string
  jwtLifetime: number
  /** RFC 8030 §5.3. `high` wakes a sleeping phone; reserve it for what somebody would want to know now. */
  urgency?: 'very-low' | 'low' | 'normal' | 'high'
  /**
   * RFC 8030 §5.4: a push still waiting on the service is *replaced* by a newer one with the same
   * topic, so a phone that was offline for an hour gets one message per topic rather than a pile.
   * At most 32 base64url characters.
   */
  topic?: string
}

/**
 * What happened to one delivery, reduced to the three things the caller acts on: it worked; the
 * subscription is gone for good (404/410 — the browser unsubscribed or the push service expired it)
 * and must be deleted; or something transient went wrong and it may be worth keeping.
 */
type PushResult = { outcome: 'sent' } | { outcome: 'gone'; status: number } | { outcome: 'failed'; status: number | null }

const sendPush = async (
  keys: VapidKeys,
  target: PushTarget,
  payload: unknown,
  options: PushOptions,
): Promise<PushResult> => {
  let response: Response
  try {
    const body = await encryptPayload(target, encoder.encode(JSON.stringify(payload)))
    const headers: Record<string, string> = {
      Authorization: await vapidAuthorization(keys, target.endpoint, options.subject, options.jwtLifetime),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(options.ttl),
      Urgency: options.urgency ?? 'normal',
    }
    if (options.topic) {
      headers.Topic = options.topic
    }
    response = await fetch(target.endpoint, { method: 'POST', headers, body })
  } catch (error) {
    // A subscription whose keys do not import, or a push service that cannot be reached. Neither
    // says the subscription is dead, so it is a failure rather than a deletion.
    console.error('web push delivery threw', error instanceof Error ? error.message : error)
    return { outcome: 'failed', status: null }
  }

  if (response.status === 404 || response.status === 410) {
    return { outcome: 'gone', status: response.status }
  }
  if (!response.ok) {
    return { outcome: 'failed', status: response.status }
  }
  return { outcome: 'sent' }
}

export { encryptPayload, fromBase64Url, loadVapidKeys, sendPush, toBase64Url, vapidAuthorization }
export type { PushOptions, PushResult, PushTarget, VapidKeys }
