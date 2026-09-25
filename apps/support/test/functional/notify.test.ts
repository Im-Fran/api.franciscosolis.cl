import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '@/db/client'
import { ingestEmail } from '@/services/inbound'
import type { InboundMessage } from '@/services/inbound'
import { clearDatabase, countRows, firstRow } from '../helpers/db'
import { captureNotifications, failNotifications } from '../helpers/queue'
import { asAgent, asLinkHolder } from '../helpers/tokens'

/**
 * What this Worker publishes for `apps/notifications`: the bell beside the email, never instead of
 * it. Every test here also has an email path that is asserted elsewhere and deliberately untouched.
 */

const call = (path: string, init: RequestInit = {}) => SELF.fetch(`https://support.test${path}`, init)

const openTicket = async (overrides: Record<string, unknown> = {}) => {
  const response = await call('/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subject: 'Cannot sign in',
      body: 'The magic link never arrives in my inbox.',
      email: 'someone@example.test',
      name: 'Someone',
      ...overrides,
    }),
  })
  const body = (await response.json()) as { data: { reference: string; url: string } }
  const row = await firstRow<{ id: string; reply_key: string }>('SELECT id, reply_key FROM tickets ORDER BY number DESC')
  const secret = new URL(body.data.url).hash.replace('#k=', '')
  return { id: row!.id, replyKey: row!.reply_key, reference: body.data.reference, secret }
}

/** The link a token makes when it arrives, written directly: how it got there is `me.ts`'s business. */
const linkAccount = (ticketId: string, userId: string) =>
  env.DB.prepare('UPDATE tickets SET requester_user_id = ? WHERE id = ?').bind(userId, ticketId).run()

const reply = async (ticketId: string, body: Record<string, unknown> = { body: 'We are on it' }) =>
  call(`/admin/tickets/${ticketId}/messages`, { method: 'POST', headers: await asAgent(), body: JSON.stringify(body) })

let queue: ReturnType<typeof captureNotifications>

beforeEach(async () => {
  await clearDatabase()
  queue = captureNotifications()
})
afterEach(() => queue.restore())

describe('support.ticket_reply', () => {
  it('is published for the requester when the team answers in public', async () => {
    const { id } = await openTicket()
    await linkAccount(id, 'visitor-42')

    expect((await reply(id)).status).toBe(201)

    expect(queue.sent).toHaveLength(1)
    const [event] = queue.sent
    expect(event).toMatchObject({
      version: 1,
      type: 'support.ticket_reply',
      user: { id: 'visitor-42', email: 'someone@example.test', name: 'Someone' },
      data: { reference: 'FS-1001', subject: 'Cannot sign in', author_name: 'Francisco Solis' },
      url: '/tickets/FS-1001',
    })
    expect(event?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(Date.parse(event?.occurred_at ?? '')).not.toBeNaN()
  })

  it('still schedules the digest email exactly as before', async () => {
    const { id } = await openTicket()
    await linkAccount(id, 'visitor-42')

    await reply(id)

    expect(await countRows('ticket_notifications')).toBe(1)
  })

  it('publishes nothing for a requester with no known account', async () => {
    const { id } = await openTicket()

    await reply(id)

    expect(queue.sent).toHaveLength(0)
    // The email half does not depend on an account, and is untouched.
    expect(await countRows('ticket_notifications')).toBe(1)
  })

  it('publishes nothing for an internal note', async () => {
    const { id } = await openTicket()
    await linkAccount(id, 'visitor-42')

    await reply(id, { body: 'Internal thought', kind: 'note' })

    expect(queue.sent).toHaveLength(0)
  })

  it('publishes nothing when the requester writes on their own ticket', async () => {
    const { id, reference, secret } = await openTicket()
    await linkAccount(id, 'visitor-42')

    const response = await call(`/tickets/${reference}/messages`, {
      method: 'POST',
      headers: asLinkHolder(secret),
      body: JSON.stringify({ body: 'Any news?' }),
    })

    expect(response.status).toBe(201)
    expect(queue.sent).toHaveLength(0)
  })

  it('does not tell an agent about their own answer on a ticket they filed', async () => {
    const { id } = await openTicket({ email: 'fran@franciscosolis.cl' })
    await linkAccount(id, 'agent-1')

    await reply(id)

    expect(queue.sent).toHaveLength(0)
  })

  it('is published when an agent answers from their mail client', async () => {
    const { id, replyKey } = await openTicket()
    await linkAccount(id, 'visitor-42')
    await call(`/admin/tickets/${id}/assignee`, {
      method: 'PUT',
      headers: await asAgent(),
      body: JSON.stringify({ email: 'fran@franciscosolis.cl' }),
    })

    const inbound: InboundMessage = {
      messageId: '<agent-reply@example.test>',
      from: 'fran@franciscosolis.cl',
      to: `reply+${replyKey}@franciscosolis.cl`,
      subject: 'Re: Cannot sign in',
      text: 'Fixed on our side.',
      html: null,
      date: null,
      inReplyTo: null,
      references: [],
      attachments: [],
      rawSize: 512,
    }
    expect((await ingestEmail(getDb(env), env, inbound)).outcome).toBe('appended')

    expect(queue.ofType('support.ticket_reply')).toEqual([
      expect.objectContaining({ user: expect.objectContaining({ id: 'visitor-42' }), data: expect.objectContaining({ author_name: null }) }),
    ])
  })

  it('does not fail the reply when the queue is unavailable', async () => {
    queue.restore()
    const outage = failNotifications()
    const { id } = await openTicket()
    await linkAccount(id, 'visitor-42')

    try {
      expect((await reply(id)).status).toBe(201)
    } finally {
      outage.restore()
    }
    expect(await countRows('ticket_notifications')).toBe(1)
  })
})

describe('support.participant_added', () => {
  const addParticipant = async (ticketId: string, email: string) =>
    call(`/admin/tickets/${ticketId}/participants`, {
      method: 'POST',
      headers: await asAgent(),
      body: JSON.stringify({ email }),
    })

  it('is published for somebody whose address this Worker has seen signed in', async () => {
    // A ticket of their own, linked to their account, is the evidence.
    const earlier = await openTicket({ email: 'colleague@example.test' })
    await linkAccount(earlier.id, 'visitor-7')
    const { id } = await openTicket({ subject: 'Billing question' })

    expect((await addParticipant(id, 'colleague@example.test')).status).toBe(201)

    expect(queue.ofType('support.participant_added')).toEqual([
      expect.objectContaining({
        version: 1,
        user: expect.objectContaining({ id: 'visitor-7', email: 'colleague@example.test' }),
        data: { reference: 'FS-1002', subject: 'Billing question' },
        url: '/tickets/FS-1002',
      }),
    ])
  })

  it('is skipped for an address with no account behind it', async () => {
    const { id } = await openTicket()

    expect((await addParticipant(id, 'stranger@example.test')).status).toBe(201)

    expect(queue.sent).toHaveLength(0)
  })

  it('does not fail the request when the queue is unavailable', async () => {
    queue.restore()
    const outage = failNotifications()
    const earlier = await openTicket({ email: 'colleague@example.test' })
    await linkAccount(earlier.id, 'visitor-7')
    const { id } = await openTicket()

    try {
      expect((await addParticipant(id, 'colleague@example.test')).status).toBe(201)
    } finally {
      outage.restore()
    }
  })
})
