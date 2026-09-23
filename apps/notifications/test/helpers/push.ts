import { vi } from 'vitest'
import { fromBase64Url, toBase64Url } from '@/lib/webpush'

/**
 * A browser, as far as Web Push is concerned: a P-256 key pair and an auth secret, a subscription
 * built from them, and the ability to decrypt what the Worker sends it.
 *
 * Decrypting is written out independently of `src/lib/webpush.ts` — from the receiving side of
 * RFC 8291 — so a mistake in the encryption cannot be mirrored by the same mistake here and pass.
 */

const encoder = new TextEncoder()

const hmac = async (key: Uint8Array, data: Uint8Array) =>
  new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
      data,
    ),
  )

const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const expand = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) =>
  (await hmac(await hmac(salt, ikm), join(info, new Uint8Array([1])))).slice(0, length)

const createBrowser = async (endpoint = `https://push.example.test/send/${crypto.randomUUID()}`) => {
  const keys = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer)
  const authSecret = crypto.getRandomValues(new Uint8Array(16))

  const subscription = {
    endpoint,
    keys: { p256dh: toBase64Url(publicRaw), auth: toBase64Url(authSecret) },
  }

  /** Decrypts an `aes128gcm` body addressed to this browser and parses the JSON inside. */
  const decrypt = async (body: Uint8Array): Promise<unknown> => {
    const salt = body.slice(0, 16)
    const idLength = body[20]
    const serverPublic = body.slice(21, 21 + idLength)
    const ciphertext = body.slice(21 + idLength)

    const serverKey = await crypto.subtle.importKey('raw', serverPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, keys.privateKey, 256))
    const ikm = await expand(authSecret, shared, join(encoder.encode('WebPush: info\0'), publicRaw, serverPublic), 32)
    const cek = await expand(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16)
    const nonce = await expand(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12)

    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce },
        await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']),
        ciphertext,
      ),
    )
    // The last record ends with the 0x02 delimiter, followed by nothing since no padding is used.
    if (plain[plain.length - 1] !== 2) {
      throw new Error('missing the last-record delimiter')
    }
    return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)))
  }

  return { subscription, decrypt }
}

type CapturedPush = { url: string; headers: Headers; body: Uint8Array }

/**
 * Replaces global `fetch` — the channel pushes leave through — with a recorder that answers every
 * push with `status` (or per endpoint, through `statusFor`).
 */
const capturePushes = (statusFor: (url: string) => number = () => 201) => {
  const pushes: CapturedPush[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    pushes.push({
      url,
      headers: new Headers(init?.headers),
      body: new Uint8Array(init?.body as ArrayBuffer | Uint8Array),
    })
    return new Response(null, { status: statusFor(url) })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { pushes, fetchMock }
}

/** Decodes the payload half of the VAPID JWT in an `Authorization` header. */
const readVapid = (authorization: string) => {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization)
  if (!match) {
    throw new Error(`not a VAPID authorization header: ${authorization}`)
  }
  const [header, payload, signature] = match[1].split('.')
  return {
    header: JSON.parse(new TextDecoder().decode(fromBase64Url(header))),
    payload: JSON.parse(new TextDecoder().decode(fromBase64Url(payload))),
    signingInput: `${header}.${payload}`,
    signature: fromBase64Url(signature),
    publicKey: match[2],
  }
}

export { capturePushes, createBrowser, readVapid }
export type { CapturedPush }
