import { describe, expect, it } from 'vitest'
import { encryptPayload, fromBase64Url, loadVapidKeys, toBase64Url, vapidAuthorization } from '@/lib/webpush'
import { createBrowser, readVapid } from '../helpers/push'

const generateVapidJwk = async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  return { jwk: (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey, publicKey: pair.publicKey }
}

describe('RFC 8291 payload encryption', () => {
  it('produces a body the subscribed browser can decrypt', async () => {
    const browser = await createBrowser()
    const payload = { title: 'Nuevo inicio de sesión', body: 'Ingreso desde Chrome · Santiago', url: '/account' }

    const body = await encryptPayload(browser.subscription.keys, new TextEncoder().encode(JSON.stringify(payload)))

    expect(await browser.decrypt(body)).toEqual(payload)
  })

  it('writes the RFC 8188 header: salt, a 4096-byte record size and the 65-byte ephemeral key', async () => {
    const browser = await createBrowser()
    const body = await encryptPayload(browser.subscription.keys, new TextEncoder().encode('{}'))

    expect(new DataView(body.buffer, body.byteOffset).getUint32(16)).toBe(4096)
    expect(body[20]).toBe(65)
    expect(body[21]).toBe(4) // an uncompressed P-256 point
  })

  it('never reuses a salt or an ephemeral key, so two identical messages differ', async () => {
    const browser = await createBrowser()
    const plaintext = new TextEncoder().encode('{"same":true}')
    const first = await encryptPayload(browser.subscription.keys, plaintext)
    const second = await encryptPayload(browser.subscription.keys, plaintext)

    expect(toBase64Url(first.slice(0, 86))).not.toBe(toBase64Url(second.slice(0, 86)))
  })

  it('cannot be read by a different browser', async () => {
    const intended = await createBrowser()
    const other = await createBrowser()
    const body = await encryptPayload(intended.subscription.keys, new TextEncoder().encode('{"secret":1}'))

    await expect(other.decrypt(body)).rejects.toThrow()
  })
})

describe('VAPID keys and tokens', () => {
  it('derives the public key from the private JWK alone', async () => {
    const { jwk, publicKey } = await generateVapidJwk()
    const keys = await loadVapidKeys(JSON.stringify(jwk))
    const raw = new Uint8Array((await crypto.subtle.exportKey('raw', publicKey)) as ArrayBuffer)

    expect(keys?.publicKey).toBe(toBase64Url(raw))
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not JSON', 'not a key'],
    ['the wrong curve', JSON.stringify({ kty: 'EC', crv: 'P-384', d: 'a', x: 'b', y: 'c' })],
    ['a public key only', JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'b', y: 'c' })],
  ])('treats a %s secret as push not being configured', async (_, secret) => {
    expect(await loadVapidKeys(secret)).toBeNull()
  })

  it('signs an ES256 token for the push service origin that verifies against the public key', async () => {
    const { jwk, publicKey } = await generateVapidJwk()
    const keys = (await loadVapidKeys(JSON.stringify(jwk)))!
    const now = new Date('2026-09-23T12:00:00Z')

    const header = await vapidAuthorization(keys, 'https://fcm.googleapis.com/fcm/send/abc', 'mailto:hola@franciscosolis.cl', 3600, now)
    const token = readVapid(header)

    expect(token.header).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(token.payload).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: Math.floor(now.getTime() / 1000) + 3600,
      sub: 'mailto:hola@franciscosolis.cl',
    })
    expect(token.publicKey).toBe(keys.publicKey)
    expect(token.signature).toHaveLength(64)
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      token.signature,
      new TextEncoder().encode(token.signingInput),
    )
    expect(valid).toBe(true)
  })

  it('round-trips base64url without padding', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(33))
    const encoded = toBase64Url(bytes)
    expect(encoded).not.toMatch(/[+/=]/)
    expect(fromBase64Url(encoded)).toEqual(bytes)
  })
})
