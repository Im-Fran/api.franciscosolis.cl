import { SELF } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'
import { installVapidKey, removeVapidKey } from '../helpers/events'

describe('GET /', () => {
  afterEach(() => {
    removeVapidKey()
  })

  it('advertises the vocabularies, the digest clock and no key while push is off', async () => {
    const response = await SELF.fetch('https://notifications.test/')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=UTF-8')
    expect(await response.json()).toMatchObject({
      code: 200,
      data: {
        categories: ['account', 'support', 'marketplace'],
        email_frequencies: ['immediate', 'daily', 'weekly', 'never'],
        digest: { timezone: 'America/Santiago', hour: 9, weekly_day: 'monday' },
        push: { vapid_public_key: null },
      },
    })
  })

  it('publishes the VAPID public key a browser subscribes with', async () => {
    await installVapidKey()
    const body = await (await SELF.fetch('https://notifications.test/')).json<{ data: { push: { vapid_public_key: string } } }>()
    expect(body.data.push.vapid_public_key).toMatch(/^B[A-Za-z0-9_-]{86}$/)
  })

  it('documents itself', async () => {
    const response = await SELF.fetch('https://notifications.test/openapi.json')
    const spec = await response.json<{ paths: Record<string, unknown> }>()
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/me/notifications', '/me/preferences', '/me/push-subscriptions']),
    )
  })
})
