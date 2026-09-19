import { describe, expect, it } from 'vitest'
import { mapPaymentStatus, verifyWebhookSignature } from '@/lib/mercadopago'

const SECRET = 'test-webhook-secret'

const sign = async (manifest: string) => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const signatureFor = async (dataId: string, requestId: string, ts = '1700000000') =>
  `ts=${ts},v1=${await sign(`id:${dataId};request-id:${requestId};ts:${ts};`)}`

describe('verifyWebhookSignature', () => {
  it('accepts a signature over the manifest MercadoPago actually signs', async () => {
    const signature = await signatureFor('123456', 'req-1')
    await expect(
      verifyWebhookSignature(SECRET, { signature, requestId: 'req-1', dataId: '123456' }),
    ).resolves.toBe(true)
  })

  it('lowercases a non-numeric id before signing, because the provider does', async () => {
    const signature = await signatureFor('abc-def', 'req-1')
    await expect(
      verifyWebhookSignature(SECRET, { signature, requestId: 'req-1', dataId: 'ABC-DEF' }),
    ).resolves.toBe(true)
  })

  it('refuses a signature for a different payment or a different request', async () => {
    const signature = await signatureFor('123456', 'req-1')
    await expect(verifyWebhookSignature(SECRET, { signature, requestId: 'req-1', dataId: '999999' })).resolves.toBe(false)
    await expect(verifyWebhookSignature(SECRET, { signature, requestId: 'req-2', dataId: '123456' })).resolves.toBe(false)
  })

  it('refuses when a part of the manifest is missing rather than signing over an empty one', async () => {
    const signature = await signatureFor('123456', 'req-1')
    await expect(verifyWebhookSignature(SECRET, { signature, requestId: undefined, dataId: '123456' })).resolves.toBe(false)
    await expect(verifyWebhookSignature(SECRET, { signature, requestId: 'req-1', dataId: undefined })).resolves.toBe(false)
    await expect(verifyWebhookSignature(SECRET, { signature: undefined, requestId: 'req-1', dataId: '1' })).resolves.toBe(false)
  })

  it('refuses everything when no secret is configured', async () => {
    const signature = await signatureFor('123456', 'req-1')
    // Failing closed is the only safe direction for the one endpoint that can grant a licence.
    await expect(verifyWebhookSignature('', { signature, requestId: 'req-1', dataId: '123456' })).resolves.toBe(false)
  })

  it('refuses a header that carries no ts or no v1', async () => {
    await expect(
      verifyWebhookSignature(SECRET, { signature: 'v1=deadbeef', requestId: 'req-1', dataId: '1' }),
    ).resolves.toBe(false)
    await expect(
      verifyWebhookSignature(SECRET, { signature: 'ts=1700000000', requestId: 'req-1', dataId: '1' }),
    ).resolves.toBe(false)
  })
})

describe('mapPaymentStatus', () => {
  it('maps only `approved` onto the status that entitles', () => {
    expect(mapPaymentStatus('approved')).toBe('approved')
  })

  it('collapses the provider\'s waiting states into one', () => {
    expect(mapPaymentStatus('in_process')).toBe('in_process')
    expect(mapPaymentStatus('authorized')).toBe('in_process')
    expect(mapPaymentStatus('in_mediation')).toBe('in_process')
  })

  it('maps the refusals and the reversals', () => {
    expect(mapPaymentStatus('rejected')).toBe('rejected')
    expect(mapPaymentStatus('cancelled')).toBe('cancelled')
    expect(mapPaymentStatus('refunded')).toBe('refunded')
    expect(mapPaymentStatus('charged_back')).toBe('refunded')
  })

  it('treats a status it has never seen as pending rather than as paid', () => {
    expect(mapPaymentStatus('something_new')).toBe('pending')
  })
})
