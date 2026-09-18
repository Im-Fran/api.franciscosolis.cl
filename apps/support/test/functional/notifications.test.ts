import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '@/db/client'
import { NOTIFICATIONS } from '@/lib/config'
import { cancelNotificationsFor, sweepNotifications } from '@/services/notifications'
import { findTicketById, ticketReplyAddress } from '@/services/tickets'
import { allRows, clearDatabase, firstRow } from '../helpers/db'
import { captureEmail } from '../helpers/email'
import { asAgent, asLinkHolder } from '../helpers/tokens'

/**
 * The 30-minute rule.
 *
 * Time is not mocked. `sweepNotifications` takes the moment to sweep as an argument precisely so a
 * test can hand it one thirty-one minutes from now instead of waiting, and so the cron handler stays
 * a three-line adapter over something testable.
 */

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000)
const past = () => later(NOTIFICATIONS.delaySeconds / 60 + 1)

let mail: ReturnType<typeof captureEmail>

const call = (path: string, init: RequestInit = {}) => SELF.fetch(`https://support.test${path}`, init)

const openTicket = async (overrides: Record<string, unknown> = {}) => {
  const response = await call('/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subject: 'Cannot sign in',
      body: 'The magic link never arrives in my inbox.',
      email: 'someone@example.test',
      ...overrides,
    }),
  })
  const body = (await response.json()) as { data: { reference: string; url: string } }
  const row = await firstRow<{ id: string }>('SELECT id FROM tickets ORDER BY number DESC')
  return { id: row!.id, reference: body.data.reference, secret: new URL(body.data.url).hash.replace('#k=', '') }
}

const agentReplies = async (ticketId: string, body: string) =>
  call(`/admin/tickets/${ticketId}/messages`, {
    method: 'POST',
    headers: await asAgent(),
    body: JSON.stringify({ body }),
  })

const pending = () =>
  allRows<{ id: string; state: string; due_at: number; after_seq: number; recipient_email: string }>(
    'SELECT id, state, due_at, after_seq, recipient_email FROM ticket_notifications ORDER BY recipient_email',
  )

beforeEach(async () => {
  await clearDatabase()
  mail = captureEmail()
})

afterEach(() => {
  mail.restore()
})

describe('scheduling', () => {
  it('schedules nothing when the ticket is opened — only a reply starts the clock', async () => {
    await openTicket()
    expect(await pending()).toHaveLength(0)
    // The confirmation goes out immediately, though; that is not a deferred notice.
    expect(mail.sent.map((message) => message.subject)).toEqual(['[FS-1001] Cannot sign in'])
  })

  it('schedules one notice half an hour out when an agent replies', async () => {
    const { id } = await openTicket()
    const before = Date.now()
    await agentReplies(id, 'We are looking into it.')

    const rows = await pending()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.state).toBe('pending')
    expect(rows[0]?.recipient_email).toBe('someone@example.test')
    expect(rows[0]!.due_at * 1000).toBeGreaterThanOrEqual(before + NOTIFICATIONS.delaySeconds * 1000 - 2000)
  })

  it('does not extend the deadline when the agent replies again inside the window', async () => {
    const { id } = await openTicket()
    await agentReplies(id, 'First thought.')
    const first = (await pending())[0]

    await agentReplies(id, 'Second thought.')
    const rows = await pending()

    expect(rows).toHaveLength(1)
    // Extending would let a chatty agent push the deadline out indefinitely and the person would
    // never hear anything at all. The deadline stands; the digest grows.
    expect(rows[0]?.due_at).toBe(first?.due_at)
    expect(rows[0]?.id).toBe(first?.id)
  })

  it('schedules an internal note to nobody', async () => {
    const { id } = await openTicket()
    await call(`/admin/tickets/${id}/messages`, {
      method: 'POST',
      headers: await asAgent(),
      body: JSON.stringify({ body: 'Probably their spam filter.', kind: 'note' }),
    })
    expect(await pending()).toHaveLength(0)
  })

  it('schedules the watchers as well as the requester', async () => {
    const { id } = await openTicket({ cc: ['colleague@example.test'] })
    await agentReplies(id, 'We are looking into it.')

    expect((await pending()).map((row) => row.recipient_email)).toEqual([
      'colleague@example.test',
      'someone@example.test',
    ])
  })

  it('never schedules an agent, because agents work the queue in the console', async () => {
    const { id } = await openTicket()
    const headers = await asAgent()
    await call(`/admin/tickets/${id}/assignee`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ email: 'fran@franciscosolis.cl' }),
    })
    await agentReplies(id, 'Mine now.')

    expect((await pending()).map((row) => row.recipient_email)).toEqual(['someone@example.test'])
  })
})

describe('cancelling', () => {
  it('cancels when the requester comes back and reads the thread', async () => {
    const { id, reference, secret } = await openTicket()
    await agentReplies(id, 'We are looking into it.')

    await call(`/tickets/${reference}/messages`, {
      method: 'POST',
      headers: asLinkHolder(secret),
      body: JSON.stringify({ body: 'Thanks, still broken though.' }),
    })

    const rows = await pending()
    expect(rows[0]?.state).toBe('cancelled')
  })

  it('cancels only that person, not everybody on the ticket', async () => {
    const { id, reference, secret } = await openTicket({ cc: ['colleague@example.test'] })
    await agentReplies(id, 'We are looking into it.')

    await call(`/tickets/${reference}/messages`, {
      method: 'POST',
      headers: asLinkHolder(secret),
      body: JSON.stringify({ body: 'Any news?' }),
    })

    const rows = await pending()
    // One watcher reading the thread must not silence the notice owed to the others.
    expect(rows.find((row) => row.recipient_email === 'someone@example.test')?.state).toBe('cancelled')
    expect(rows.find((row) => row.recipient_email === 'colleague@example.test')?.state).toBe('pending')
  })

  it('will not cancel a notice the sweep has already claimed', async () => {
    const { id } = await openTicket()
    await agentReplies(id, 'We are looking into it.')
    const db = getDb(env)

    await env.DB.prepare("UPDATE ticket_notifications SET state = 'sending'").run()
    // The cancel is scoped to `pending` precisely so it can never yank a row out from under an
    // in-flight send and strand it in a state nothing resolves.
    expect(await cancelNotificationsFor(db, id, 'someone@example.test')).toBe(0)
    expect((await pending())[0]?.state).toBe('sending')
  })
})

describe('the sweep', () => {
  it('sends nothing before the deadline', async () => {
    const { id } = await openTicket()
    await agentReplies(id, 'We are looking into it.')
    mail.sent.length = 0

    const result = await sweepNotifications(getDb(env), env, later(5))
    expect(result.claimed).toBe(0)
    expect(mail.sent).toHaveLength(0)
  })

  it('sends one digest covering every reply since the last notice', async () => {
    const { id } = await openTicket()
    await agentReplies(id, 'First reply.')
    await agentReplies(id, 'Second reply.')
    mail.sent.length = 0

    const result = await sweepNotifications(getDb(env), env, past())
    expect(result).toMatchObject({ claimed: 1, sent: 1, failed: 0 })
    expect(mail.sent).toHaveLength(1)

    const [message] = mail.sent
    expect(message?.to).toEqual(['someone@example.test'])
    expect(message?.subject).toBe('[FS-1001] Cannot sign in')
    // Both replies in one message, not one message each.
    expect(message?.text).toContain('First reply.')
    expect(message?.text).toContain('Second reply.')
  })

  it('points a reply back at the ticket rather than at the sending address', async () => {
    const { id } = await openTicket()
    await agentReplies(id, 'We are looking into it.')
    mail.sent.length = 0
    await sweepNotifications(getDb(env), env, past())

    const [message] = mail.sent
    const ticket = await findTicketById(getDb(env), id)
    // `mail.franciscosolis.cl` sends and has no MX; the apex is where Email Routing listens. A
    // reply-to of the sending address would bounce and quietly remove the whole inbound half. It
    // is also the ticket's own `reply+<key>@` address rather than the generic one, which is what
    // makes a reply thread straight back onto this ticket instead of falling through to a weaker
    // match.
    expect(message?.replyTo).toBe(ticketReplyAddress(env, ticket!))
    expect(message?.replyTo).not.toBe(env.MAIL_REPLY_TO)
    expect(message?.from.email).toBe(env.MAIL_FROM_EMAIL)
  })

  it('renders an @mention in a reply as a mailto link in the digest', async () => {
    const { id } = await openTicket()
    await agentReplies(id, 'Looping in @colleague@franciscosolis.cl on this one.')
    mail.sent.length = 0
    await sweepNotifications(getDb(env), env, past())

    const [message] = mail.sent
    expect(message?.html).toContain('mailto:colleague@franciscosolis.cl')
    // The plain-text part is derived from the HTML, where html-to-text prints an anchor's href
    // after its text unless told otherwise — which rendered the address twice in a row. It reads
    // as it was typed, once.
    expect(message?.text).toContain('Looping in @colleague@franciscosolis.cl on this one.')
    expect(message?.text).not.toContain('mailto:')
  })

  it('does not send the same reply twice', async () => {
    const { id } = await openTicket()
    await agentReplies(id, 'Only once, please.')
    await sweepNotifications(getDb(env), env, past())
    mail.sent.length = 0

    await agentReplies(id, 'A later thought.')
    await sweepNotifications(getDb(env), env, later(120))

    expect(mail.sent).toHaveLength(1)
    // The window moved on with the high-water mark, so the first reply is not quoted again.
    expect(mail.sent[0]?.text).not.toContain('Only once, please.')
    expect(mail.sent[0]?.text).toContain('A later thought.')
  })

  it('retires a notice whose replies have already been covered', async () => {
    const { id } = await openTicket()
    await agentReplies(id, 'We are looking into it.')
    await env.DB.prepare('UPDATE ticket_notifications SET after_seq = 99').run()
    mail.sent.length = 0

    const result = await sweepNotifications(getDb(env), env, past())
    expect(result).toMatchObject({ cancelled: 1, sent: 0 })
    expect(mail.sent).toHaveLength(0)
    expect((await pending())[0]?.state).toBe('cancelled')
  })

  it('says nothing about a ticket marked as spam', async () => {
    const { id } = await openTicket()
    await agentReplies(id, 'We are looking into it.')
    await call(`/admin/tickets/${id}`, {
      method: 'PATCH',
      headers: await asAgent(),
      body: JSON.stringify({ status: 'spam' }),
    })
    mail.sent.length = 0

    const result = await sweepNotifications(getDb(env), env, past())
    expect(result.sent).toBe(0)
    expect(mail.sent).toHaveLength(0)
  })

  it('still tells somebody their ticket was solved', async () => {
    const { id } = await openTicket()
    await agentReplies(id, 'Fixed it — it was a typo in your address.')
    await call(`/admin/tickets/${id}`, {
      method: 'PATCH',
      headers: await asAgent(),
      body: JSON.stringify({ status: 'solved' }),
    })
    mail.sent.length = 0

    // Silence on a solved ticket is the worst outcome of the lot: the answer exists and nobody
    // was told. Only `spam` is excluded.
    const result = await sweepNotifications(getDb(env), env, past())
    expect(result.sent).toBe(1)
  })

  it('backs off and retries when the provider refuses', async () => {
    const { id } = await openTicket()
    await agentReplies(id, 'We are looking into it.')
    mail.failWith(new Error('mailbox unavailable'))

    const result = await sweepNotifications(getDb(env), env, past())
    expect(result.failed).toBe(1)

    const row = await firstRow<{ state: string; attempts: number; last_error: string }>(
      'SELECT state, attempts, last_error FROM ticket_notifications',
    )
    expect(row?.state).toBe('pending')
    expect(row?.attempts).toBe(1)
    expect(row?.last_error).toContain('mailbox unavailable')
  })

  it('gives up after the fifth attempt rather than retrying forever', async () => {
    const { id } = await openTicket()
    await agentReplies(id, 'We are looking into it.')
    mail.failWith(new Error('mailbox unavailable'))
    await env.DB.prepare(`UPDATE ticket_notifications SET attempts = ${NOTIFICATIONS.maxAttempts - 1}`).run()

    await sweepNotifications(getDb(env), env, past())

    const row = await firstRow<{ state: string }>('SELECT state FROM ticket_notifications')
    // A `failed` row is kept, not deleted: GET /admin/notifications exists to show exactly this.
    expect(row?.state).toBe('failed')
  })

  it('puts back a notice a dead isolate left mid-send', async () => {
    const { id } = await openTicket()
    await agentReplies(id, 'We are looking into it.')
    const stale = Math.floor((Date.now() - (NOTIFICATIONS.reapAfterSeconds + 60) * 1000) / 1000)
    await env.DB.prepare(`UPDATE ticket_notifications SET state = 'sending', claimed_at = ${stale}`).run()
    mail.sent.length = 0

    const result = await sweepNotifications(getDb(env), env, past())
    // Without the reaper this row sits in `sending` forever and that person never hears about that
    // ticket again — a silent, permanent, single-recipient outage.
    expect(result.reaped).toBe(1)
    expect(result.sent).toBe(1)
  })

  it('records the send on the ticket timeline', async () => {
    const { id } = await openTicket()
    await agentReplies(id, 'We are looking into it.')
    await sweepNotifications(getDb(env), env, past())

    const events = await allRows<{ event: string }>('SELECT event FROM ticket_events')
    expect(events.map((row) => row.event)).toContain('notification_sent')
  })
})

describe('participants', () => {
  it('emails somebody added mid-thread instead of back-filling them into the digest', async () => {
    const { id } = await openTicket()
    await agentReplies(id, 'An earlier reply they were not part of.')
    mail.sent.length = 0

    await call(`/admin/tickets/${id}/participants`, {
      method: 'POST',
      headers: await asAgent(),
      body: JSON.stringify({ email: 'colleague@example.test' }),
    })

    expect(mail.sent.map((message) => message.to[0])).toEqual(['colleague@example.test'])
    expect(mail.sent[0]?.subject).toBe('You were added to FS-1001')

    await sweepNotifications(getDb(env), env, past())
    const digests = mail.sent.filter((message) => message.to[0] === 'colleague@example.test' && message.subject.startsWith('[FS-'))
    // They were added after the reply, so the digest has nothing for them: mailing a stranger a
    // conversation they were not part of is not a notification, it is a leak.
    expect(digests).toHaveLength(0)
  })
})

describe('POST /tickets/resend-link', () => {
  it('rotates the secret and emails a fresh link', async () => {
    const { reference, secret } = await openTicket()
    mail.sent.length = 0

    const response = await call('/tickets/resend-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference, email: 'someone@example.test' }),
    })
    expect(response.status).toBe(202)
    expect(mail.sent).toHaveLength(1)

    // The old link stops working, which is the right way round: the request came from somebody who
    // no longer has it.
    expect((await call(`/tickets/${reference}`, { headers: asLinkHolder(secret) })).status).toBe(404)
  })

  it('answers the same way for a ticket that does not exist', async () => {
    const real = await openTicket()
    mail.sent.length = 0

    const unknown = await call('/tickets/resend-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: 'FS-999999', email: 'someone@example.test' }),
    })
    const wrongEmail = await call('/tickets/resend-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: real.reference, email: 'stranger@example.test' }),
    })

    // Anything other than one answer would make this a way to ask whether somebody has ever
    // contacted support, which is not ours to disclose.
    expect(unknown.status).toBe(202)
    expect(wrongEmail.status).toBe(202)
    expect(await unknown.text()).toBe(await wrongEmail.text())
    expect(mail.sent).toHaveLength(0)
  })

  it('is not swallowed by the :reference route registered after it', async () => {
    const response = await call('/tickets/resend-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: 'FS-1', email: 'someone@example.test' }),
    })
    // Hono runs matching handlers in registration order, so a literal segment declared after a
    // parametric one is unreachable. This is the guard for that.
    expect(response.status).toBe(202)
  })
})
