import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, seedProduct } from '../helpers/db'

const get = (path: string, init: RequestInit = {}) => SELF.fetch(`https://marketplace.test${path}`, init)

describe('error shapes', () => {
  beforeEach(clearDatabase)

  it('answers a miss with the JSON envelope the rest of the service uses', async () => {
    const response = await get('/products/nope')

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ code: 404, error: 'Product not found' })
  })

  it('answers 404 for a path this Worker does not serve', async () => {
    expect((await get('/nothing/here')).status).toBe(404)
  })

  it.each(['POST', 'PATCH', 'DELETE'])('answers 404 for %s on a public read route', async (method) => {
    await seedProduct({ slug: 'openbattery' })

    expect((await get('/products/openbattery', { method })).status).toBe(404)
  })

  /** Only the public reads opt into a shared cache; an error must never be one of them. */
  it('does not let a 404 into a shared cache', async () => {
    const response = await get('/products/nope')

    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})
