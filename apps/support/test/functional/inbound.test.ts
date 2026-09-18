import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '@/db/client'
import { INBOUND } from '@/lib/config'
import { ingestEmail } from '@/services/inbound'
import type { InboundMessage } from '@/services/inbound'
import { allRows, clearDatabase, countRows, firstRow } from '../helpers/db'
import { captureEmail } from '../helpers/email'
import { deliver } from '../helpers/inbound'
import { htmlOnly, plainText, quotedReply, withAttachment, withoutMessageId } from '../fixtures/mime'
import { stubAi, stubAiResponse } from '../helpers/ai'
import { asAgent } from '../helpers/tokens'

let mail: ReturnType<typeof captureEmail>

const message = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  messageId: '<m-1@example.test>',
  from: 'someone@example.test',
  to: 'soporte@franciscosolis.cl',
  subject: 'Cannot sign in',
  text: 'The link never arrives.',
  html: null,
  date: 'Tue, 3 Jan 2026 14:02:00 +0000',
  inReplyTo: null,
  references: [],
  attachments: [],
  rawSize: 1024,
  ...overrides,
})

const ingest = (overrides: Partial<InboundMessage> = {}) => ingestEmail(getDb(env), env, message(overrides))

beforeEach(async () => {
  await clearDatabase()
  mail = captureEmail()
})

afterEach(() => {
  mail.restore()
})

describe('the email() handler', () => {
  it('opens a ticket from a plain-text message', async () => {
    await deliver(plainText)

    const ticket = await firstRow<{ number: number; subject: string; source: string; requester_email: string }>(
      'SELECT number, subject, source, requester_email FROM tickets',
    )
    expect(ticket).toMatchObject({
      number: 1001,
      subject: 'The sign-in link never arrives',
      source: 'email',
      requester_email: 'someone@example.test',
    })

    const body = await firstRow<{ body_text: string }>('SELECT body_text FROM ticket_messages')
    expect(body?.body_text).toContain('four times')
    // The confirmation goes back to the sender, carrying the link.
    expect(mail.sent.map((sent) => sent.to[0])).toEqual(['someone@example.test'])
  })

  it('converts an HTML-only message to text and stores no markup', async () => {
    await deliver(htmlOnly)

    const body = await firstRow<{ body_text: string }>('SELECT body_text FROM ticket_messages')
    expect(body?.body_text).toContain('two seats but we only have one')
    // The schema has no column for HTML, and this is why it does not need one.
    expect(body?.body_text).not.toContain('<b>')
    expect(body?.body_text).not.toContain('alert')
  })

  it('records what was attached without storing any of it', async () => {
    await deliver(withAttachment)

    const inbound = await firstRow<{ attachment_count: number }>('SELECT attachment_count FROM inbound_emails')
    expect(inbound?.attachment_count).toBe(1)

    const body = await firstRow<{ body_text: string; attachments_meta: string }>(
      'SELECT body_text, attachments_meta FROM ticket_messages',
    )
    // Dropping them silently is the one unacceptable option: an agent would answer about a
    // screenshot they have no idea exists.
    expect(body?.body_text).toContain('screenshot.png')
    expect(body?.body_text).toContain('not stored')
    expect(JSON.parse(body!.attachments_meta)).toHaveLength(1)
  })

  it('refuses a message too large to be worth buffering', async () => {
    const { setReject } = await deliver(plainText, { rawSize: INBOUND.maxBytes + 1 })
    expect(setReject).toHaveBeenCalledWith('Message too large')
    expect(await countRows('tickets')).toBe(0)
  })

  it('refuses a message addressed to somewhere this Worker does not serve', async () => {
    const { setReject } = await deliver(plainText, { to: 'ventas@franciscosolis.cl' })
    expect(setReject).toHaveBeenCalledWith('Unknown recipient')
    expect(await countRows('tickets')).toBe(0)
  })

  it('handles a message with no Message-ID at all', async () => {
    await deliver(withoutMessageId)
    expect(await countRows('tickets')).toBe(1)
  })
})

describe('idempotency', () => {
  it('ignores a redelivery of the same message', async () => {
    expect((await ingest()).outcome).toBe('created')
    // Email Routing retries; without the unique key this posts the same reply twice.
    expect((await ingest()).outcome).toBe('duplicate')
    expect(await countRows('tickets')).toBe(1)
  })

  it('deduplicates a header-less message on its content rather than at random', async () => {
    const headerless = { messageId: null }
    expect((await ingest(headerless)).outcome).toBe('created')
    expect((await ingest(headerless)).outcome).toBe('duplicate')

    // A genuinely different message from the same sender still gets through.
    expect((await ingest({ messageId: null, subject: 'A different problem', rawSize: 2048 })).outcome).toBe('created')
  })
})

describe('matching a reply to its thread', () => {
  const openTicket = async () => {
    const created = await ingest()
    if (created.outcome !== 'created') {
      throw new Error('expected a ticket')
    }
    return created.ticket
  }

  it('matches on the reply key in the envelope address, the strongest signal there is', async () => {
    const ticket = await openTicket()
    const result = await ingest({
      messageId: '<reply-1@example.test>',
      to: `reply+${ticket.replyKey}@franciscosolis.cl`,
      subject: 'Anything at all',
    })

    expect(result.outcome).toBe('appended')
    expect(await countRows('tickets')).toBe(1)
    expect(await firstRow<{ match_strategy: string }>(
      "SELECT match_strategy FROM inbound_emails WHERE message_id = '<reply-1@example.test>'",
    )).toMatchObject({ match_strategy: 'reply_key' })
  })

  it('matches on In-Reply-To against mail we actually sent', async () => {
    const ticket = await openTicket()
    // The confirmation was logged with the provider's id; a client echoes it back.
    const sent = await firstRow<{ provider_message_id: string }>(
      'SELECT provider_message_id FROM email_messages WHERE ticket_id = ?',
      ticket.id,
    )

    const result = await ingest({
      messageId: '<reply-2@example.test>',
      subject: 'Re: whatever',
      inReplyTo: sent!.provider_message_id,
    })

    expect(result.outcome).toBe('appended')
    expect(await countRows('tickets')).toBe(1)
  })

  it('honours a subject tag only when the sender is already on the ticket', async () => {
    const ticket = await openTicket()
    const tagged = `Re: [FS-${ticket.number}] Cannot sign in`

    const fromRequester = await ingest({ messageId: '<tag-1@example.test>', subject: tagged })
    expect(fromRequester.outcome).toBe('appended')

    const fromStranger = await ingest({
      messageId: '<tag-2@example.test>',
      from: 'stranger@example.test',
      subject: tagged,
    })
    // A subject tag is one line for anybody to forge. Honouring it unconditionally would let a
    // stranger inject a message into — and read the replies on — somebody else's thread.
    expect(fromStranger.outcome).toBe('created')
    expect(await countRows('tickets')).toBe(2)
  })

  it('strips a stale tag rather than announcing the new ticket under two references', async () => {
    const result = await ingest({ subject: 'Re: [FS-9999] Something else entirely' })
    expect(result.outcome).toBe('created')

    const ticket = await firstRow<{ subject: string }>('SELECT subject FROM tickets')
    expect(ticket?.subject).toBe('Something else entirely')
  })

  it('trims the quoted history off a reply', async () => {
    const ticket = await openTicket()
    await deliver(quotedReply('Re: Cannot sign in', 'quoted-1', `reply+${ticket.replyKey}@franciscosolis.cl`), {
      to: `reply+${ticket.replyKey}@franciscosolis.cl`,
    })

    const rows = await allRows<{ body_text: string; body_text_raw: string | null }>(
      'SELECT body_text, body_text_raw FROM ticket_messages ORDER BY seq',
    )
    const reply = rows[rows.length - 1]
    expect(reply?.body_text).toBe('That did not help, it still fails.')
    expect(reply?.body_text).not.toContain('Could you try')
    // Kept, so a trim that took too much is recoverable.
    expect(reply?.body_text_raw).toContain('Could you try')
  })

  it('reopens a ticket somebody had marked finished', async () => {
    const ticket = await openTicket()
    await SELF.fetch(`https://support.test/admin/tickets/${ticket.id}`, {
      method: 'PATCH',
      headers: await asAgent(),
      body: JSON.stringify({ status: 'closed' }),
    })

    await ingest({ messageId: '<reopen-1@example.test>', to: `reply+${ticket.replyKey}@franciscosolis.cl` })

    expect((await firstRow<{ status: string }>('SELECT status FROM tickets'))?.status).toBe('open')
    expect((await allRows<{ event: string }>('SELECT event FROM ticket_events')).map((row) => row.event)).toContain(
      'reopened',
    )
  })

  it('says nothing back to a ticket marked as spam', async () => {
    const ticket = await openTicket()
    await SELF.fetch(`https://support.test/admin/tickets/${ticket.id}`, {
      method: 'PATCH',
      headers: await asAgent(),
      body: JSON.stringify({ status: 'spam' }),
    })
    mail.sent.length = 0

    const result = await ingest({ messageId: '<spam-1@example.test>', to: `reply+${ticket.replyKey}@franciscosolis.cl` })
    expect(result.outcome).toBe('ignored')
    expect(mail.sent).toHaveLength(0)
  })
})

describe('abuse controls', () => {
  it('refuses a sender past the hourly limit, and still counts the refusal', async () => {
    for (let i = 0; i <= INBOUND.hourlyLimitPerSender; i += 1) {
      await ingest({ messageId: `<flood-${i}@example.test>`, subject: `Message ${i}` })
    }

    const over = await ingest({ messageId: '<flood-final@example.test>', subject: 'One too many' })
    expect(over.outcome).toBe('rejected')

    const refused = await firstRow<{ outcome: string; reject_reason: string }>(
      "SELECT outcome, reject_reason FROM inbound_emails WHERE message_id = '<flood-final@example.test>'",
    )
    // Recorded rather than dropped: "why did this email never show up" is the question a support
    // system gets asked about itself, and the answer has to be in the database.
    expect(refused).toMatchObject({ outcome: 'rejected', reject_reason: 'rate limited' })
  })
})

describe('the AI enrichment pass', () => {
  it('improves the ticket when the model answers', async () => {
    stubAiResponse({
      response: JSON.stringify({
        subject: 'Magic link emails are not being delivered',
        summary: 'Four sign-in link requests, none delivered.',
        language: 'en',
        priority: 'high',
        contact_name: 'Someone',
      }),
    })

    await deliver(plainText)

    const ticket = await firstRow<{ subject: string; priority: string; ai_enriched: number; ai_summary: string }>(
      'SELECT subject, priority, ai_enriched, ai_summary FROM tickets',
    )
    expect(ticket).toMatchObject({
      subject: 'Magic link emails are not being delivered',
      priority: 'high',
      ai_enriched: 1,
    })
    expect(ticket?.ai_summary).toContain('Four sign-in link requests')
  })

  it('keeps the ticket when the model fails outright', async () => {
    // Thrown from inside the stub, not a pre-built rejected promise: the latter is unhandled from
    // the moment it is constructed and fails the whole run even though every test passes.
    stubAi(async () => {
      throw new Error('model unavailable')
    })
    await deliver(plainText)

    // The email is written before the model is asked, which is the whole reason a model outage
    // cannot cost an email. The worst case is a plainer subject line.
    const ticket = await firstRow<{ subject: string; ai_enriched: number }>(
      'SELECT subject, ai_enriched FROM tickets',
    )
    expect(ticket?.subject).toBe('The sign-in link never arrives')
    expect(ticket?.ai_enriched).toBe(0)
    expect((await firstRow<{ ai_ok: number | null }>('SELECT ai_ok FROM inbound_emails'))?.ai_ok).toBe(0)
  })

  it('keeps the ticket when the model answers with something that does not fit the schema', async () => {
    stubAiResponse({ response: JSON.stringify({ subject: '', priority: 'catastrophic' }) })
    await deliver(plainText)

    // JSON mode constrains the grammar, not the choices. The result is parsed before it is trusted.
    const ticket = await firstRow<{ subject: string; priority: string; ai_enriched: number }>(
      'SELECT subject, priority, ai_enriched FROM tickets',
    )
    expect(ticket).toMatchObject({
      subject: 'The sign-in link never arrives',
      priority: 'normal',
      ai_enriched: 0,
    })
  })

  it('meters every call, successful or not', async () => {
    stubAiResponse({ response: '{"not":"valid"}' })
    await deliver(plainText)

    const rows = await allRows<{ kind: string; ok: number }>('SELECT kind, ok FROM ai_requests')
    // Workers AI has no per-Worker spend cap, so without this table the first sign of a runaway
    // loop is the invoice.
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('email_extract')
  })
})
