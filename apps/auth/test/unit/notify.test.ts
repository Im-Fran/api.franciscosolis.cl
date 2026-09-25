import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildNotificationEvent, publishNotification } from '@/services/notify'
import { captureNotifications, failNotifications } from '../helpers/queue'

describe('buildNotificationEvent', () => {
  it('stamps the contract version, a fresh id and the moment it happened', () => {
    const event = buildNotificationEvent({
      type: 'account.avatar_approved',
      user: { id: 'user-1' },
      occurredAt: new Date('2026-09-17T14:32:00Z'),
    })

    expect(event).toEqual({
      version: 1,
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      type: 'account.avatar_approved',
      user: { id: 'user-1' },
      occurred_at: '2026-09-17T14:32:00.000Z',
      data: {},
      url: null,
    })
  })
})

describe('publishNotification', () => {
  let queue: ReturnType<typeof captureNotifications>
  beforeEach(() => {
    queue = captureNotifications()
  })
  afterEach(() => queue.restore())

  it('answers true once the queue has the event', async () => {
    await expect(publishNotification(env, { type: 'account.avatar_approved', user: { id: 'user-1' } })).resolves.toBe(
      true,
    )
    expect(queue.sent).toHaveLength(1)
  })

  it('publishes nothing for an event that names no account', async () => {
    await expect(publishNotification(env, { type: 'account.avatar_approved', user: { id: '' } })).resolves.toBe(false)
    expect(queue.sent).toHaveLength(0)
  })

  it('answers false instead of throwing when the queue refuses', async () => {
    queue.restore()
    const outage = failNotifications()
    try {
      await expect(publishNotification(env, { type: 'account.sign_in', user: { id: 'user-1' } })).resolves.toBe(false)
    } finally {
      outage.restore()
    }
  })
})
