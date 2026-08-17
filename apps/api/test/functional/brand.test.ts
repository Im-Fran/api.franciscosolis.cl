import { describe, expect, it } from 'vitest'
import { LOCKUP_ETAG, LOCKUP_PNG } from '@/brand'
import { gateway } from '../helpers/gateway'

/**
 * The gateway serves exactly one asset, and it is load-bearing for something that lives elsewhere:
 * every email `apps/auth` and `apps/cms` send points its `<img>` at this URL. A 404 here is a
 * broken logo in every inbox, so the path is asserted literally rather than derived.
 */
describe('GET /brand/lockup.png', () => {
  it('answers with the lockup as a PNG', async () => {
    const response = await gateway('/brand/lockup.png')

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')

    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(bytes.byteLength).toBe(LOCKUP_PNG.byteLength)
    // The 8-byte PNG signature. Serving something that is not a PNG under this name would be
    // invisible to a length check and very visible in a mail client.
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it('is cacheable and validatable', async () => {
    const response = await gateway('/brand/lockup.png')

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=604800')
    expect(response.headers.get('ETag')).toBe(LOCKUP_ETAG)
  })

  it('answers 304 with no body when the caller already holds this version', async () => {
    const response = await gateway('/brand/lockup.png', { headers: { 'If-None-Match': LOCKUP_ETAG } })

    expect(response.status).toBe(304)
    expect(response.headers.get('ETag')).toBe(LOCKUP_ETAG)
    await expect(response.text()).resolves.toBe('')
  })

  it('serves the bytes to a caller holding a different version', async () => {
    const response = await gateway('/brand/lockup.png', { headers: { 'If-None-Match': '"stale"' } })

    expect(response.status).toBe(200)
    expect((await response.arrayBuffer()).byteLength).toBe(LOCKUP_PNG.byteLength)
  })

  it('derives the ETag from the bytes, so replacing the asset invalidates caches', () => {
    // Both halves are content-dependent: the FNV-1a digest and the byte length.
    expect(LOCKUP_ETAG).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/)
    expect(LOCKUP_ETAG).toContain(LOCKUP_PNG.byteLength.toString(16))
  })

  it('is a GET-only route', async () => {
    const response = await gateway('/brand/lockup.png', { method: 'POST' })

    expect(response.status).toBe(404)
  })

  it('does not answer for another name under the same prefix', async () => {
    const response = await gateway('/brand/other.png')

    expect(response.status).toBe(404)
  })
})
