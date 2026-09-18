import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { allRows, clearDatabase, countRows, firstRow } from '../helpers/db'
import { asAgent, asLinkHolder, asRequester } from '../helpers/tokens'

const json = { 'Content-Type': 'application/json' }

const post = (path: string, body: unknown, headers: Record<string, string> = json) =>
  SELF.fetch(`https://support.test${path}`, { method: 'POST', headers, body: JSON.stringify(body) })

const get = (path: string, headers: Record<string, string> = {}) =>
  SELF.fetch(`https://support.test${path}`, { headers })

const openTicket = async (overrides: Record<string, unknown> = {}) => {
  const response = await post('/tickets', {
    subject: 'Cannot sign in',
    body: 'The magic link never arrives in my inbox.',
    email: 'someone@example.test',
    name: 'Someone',
    ...overrides,
  })
  expect(response.status).toBe(201)
  const body = (await response.json()) as { data: { reference: string; url: string } }
  const secret = new URL(body.data.url).hash.replace('#k=', '')
  return { reference: body.data.reference, secret, url: body.data.url }
}

beforeEach(clearDatabase)

describe('POST /tickets', () => {
  it('opens a ticket and hands back the only copy of the link', async () => {
    const { reference, url, secret } = await openTicket()

    expect(reference).toBe('FS-1001')
    expect(url).toBe(`https://franciscosolis.test/tickets/FS-1001#k=${secret}`)
    expect(await countRows('tickets')).toBe(1)
    // The opening message is part of the ticket, not a separate step.
    expect(await countRows('ticket_messages')).toBe(1)
    // The requester is a participant from the start, which is what the notification rule reads.
    expect(await countRows('ticket_participants')).toBe(1)
  })

  it('stores only the hash of the link secret', async () => {
    const { secret } = await openTicket()
    const row = await firstRow<{ access_token_hash: string }>('SELECT access_token_hash FROM tickets')
    expect(row?.access_token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row?.access_token_hash).not.toBe(secret)
  })

  it('numbers tickets sequentially from the seeded counter', async () => {
    const first = await openTicket()
    const second = await openTicket({ email: 'other@example.test' })
    expect(first.reference).toBe('FS-1001')
    expect(second.reference).toBe('FS-1002')
  })

  it('lowercases the requester address, because every later comparison depends on it', async () => {
    await openTicket({ email: 'MiXeD@Example.TEST' })
    const row = await firstRow<{ requester_email: string }>('SELECT requester_email FROM tickets')
    expect(row?.requester_email).toBe('mixed@example.test')
  })

  it('puts the people on copy on the ticket', async () => {
    await openTicket({ cc: ['colleague@example.test', 'boss@example.test'] })
    expect(await countRows('ticket_participants')).toBe(3)
  })

  it('does not add the requester twice when they copy themselves', async () => {
    await openTicket({ email: 'someone@example.test', cc: ['someone@example.test'] })
    expect(await countRows('ticket_participants')).toBe(1)
  })

  it.each([
    ['a missing subject', { subject: undefined }],
    ['a body too short to be a support request', { body: 'hi' }],
    ['a malformed address', { email: 'not-an-address' }],
  ])('refuses %s', async (_label, overrides) => {
    const response = await post('/tickets', {
      subject: 'Cannot sign in',
      body: 'The magic link never arrives in my inbox.',
      email: 'someone@example.test',
      ...overrides,
    })
    expect(response.status).toBe(400)
  })

  it('answers a filled-in honeypot as if it worked, and writes nothing', async () => {
    const response = await post('/tickets', {
      subject: 'Cheap watches',
      body: 'Buy now, limited offer, click here.',
      email: 'bot@example.test',
      website: 'http://spam.example',
    })
    // A 201 rather than a 4xx: telling a bot it was detected only teaches it to stop filling the
    // field in, which is the one signal that costs nothing to collect.
    expect(response.status).toBe(201)
    expect(await countRows('tickets')).toBe(0)
  })

  it('stops one address opening tickets without limit', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await post('/tickets', {
        subject: `Issue ${i}`,
        body: 'Something is not working at all.',
        email: 'repeat@example.test',
      })).status).toBe(201)
    }

    const refused = await post('/tickets', {
      subject: 'Issue 4',
      body: 'Something is not working at all.',
      email: 'repeat@example.test',
    })
    expect(refused.status).toBe(429)
    // Answered rather than dropped, with a hint about when to come back.
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0)
  })
})

describe('reading a ticket with the emailed link', () => {
  it('lets the secret through', async () => {
    const { reference, secret } = await openTicket()
    const response = await get(`/tickets/${reference}`, asLinkHolder(secret))
    expect(response.status).toBe(200)

    const body = (await response.json()) as { data: { reference: string; access_level: string } }
    expect(body.data.reference).toBe(reference)
    expect(body.data.access_level).toBe('requester')
  })

  it('also accepts ?token=, the documented curl fallback', async () => {
    const { reference, secret } = await openTicket()
    expect((await get(`/tickets/${reference}?token=${secret}`)).status).toBe(200)
  })

  it('answers 404 rather than 403 without a secret, so the reference space is not an oracle', async () => {
    const { reference } = await openTicket()
    const response = await get(`/tickets/${reference}`)
    expect(response.status).toBe(404)
    // A ticket that exists and one that does not must be indistinguishable from outside: ticket
    // numbers are short and sequential, so a 403 here would enumerate every request ever filed.
    const missing = await get('/tickets/FS-999999')
    expect(missing.status).toBe(404)
    expect(await response.text()).toBe(await missing.text())
  })

  it('refuses a perfectly valid secret belonging to a different ticket', async () => {
    const first = await openTicket()
    const second = await openTicket({ email: 'other@example.test' })
    expect((await get(`/tickets/${second.reference}`, asLinkHolder(first.secret))).status).toBe(404)
  })

  it('never returns an internal note on the requester timeline', async () => {
    const { reference, secret } = await openTicket()
    const agent = await asAgent()
    const ticket = await firstRow<{ id: string }>('SELECT id FROM tickets')

    await post(`/admin/tickets/${ticket!.id}/messages`, { body: 'Looks like a DNS issue.', kind: 'note' }, agent)
    await post(`/admin/tickets/${ticket!.id}/messages`, { body: 'We are looking into it.', kind: 'reply' }, agent)

    const response = await get(`/tickets/${reference}/timeline`, asLinkHolder(secret))
    const body = (await response.json()) as { data: Array<{ type: string; body?: string }> }
    const bodies = body.data.filter((entry) => entry.type === 'message').map((entry) => entry.body)

    expect(bodies).toContain('We are looking into it.')
    expect(bodies).not.toContain('Looks like a DNS issue.')
  })

  it('does not publish the answering agent\'s address to the requester', async () => {
    const { reference, secret } = await openTicket()
    const ticket = await firstRow<{ id: string }>('SELECT id FROM tickets')
    await post(`/admin/tickets/${ticket!.id}/messages`, { body: 'On it.' }, await asAgent())

    const response = await get(`/tickets/${reference}/timeline`, asLinkHolder(secret))
    const body = (await response.json()) as { data: Array<{ author_type?: string; author_email?: string | null }> }
    const reply = body.data.find((entry) => entry.author_type === 'agent')

    expect(reply).toBeDefined()
    expect(reply?.author_email).toBeNull()
  })

  it('still honours the secret when a session token for somebody else rides along', async () => {
    const { reference, secret } = await openTicket({ email: 'someone@example.test' })
    // The browser sends both: the website's own session, and the secret out of the emailed link.
    // Whoever is signed in has nothing to do with whether that link is valid, so a token that
    // resolves to neither an agent nor a participant must not swallow the request.
    const headers = { ...(await asRequester({ email: 'stranger@example.test' })), 'X-Support-Ticket-Token': secret }

    const response = await get(`/tickets/${reference}`, headers)
    expect(response.status).toBe(200)
    expect(((await response.json()) as { data: { reference: string } }).data.reference).toBe(reference)
  })

  it('still answers 404 for a session token with no secret beside it', async () => {
    const { reference } = await openTicket({ email: 'someone@example.test' })
    const headers = { ...(await asRequester({ email: 'stranger@example.test' })), 'X-Support-Ticket-Token': 'not-the-secret' }

    expect((await get(`/tickets/${reference}`, headers)).status).toBe(404)
  })

  it("never publishes a participant's internal tag to the requester", async () => {
    const { reference, secret } = await openTicket()
    const ticket = await firstRow<{ id: string }>('SELECT id FROM tickets')
    const agent = await asAgent()
    await post(`/admin/tickets/${ticket!.id}/participants`, { email: 'colleague@example.test', tag: 'interest' }, agent)

    const response = await get(`/tickets/${reference}`, asLinkHolder(secret))
    const body = (await response.json()) as { data: { participants: Array<Record<string, unknown>> } }

    expect(body.data.participants.length).toBeGreaterThan(0)
    for (const participant of body.data.participants) {
      expect(participant).not.toHaveProperty('tag')
    }
  })
})

describe('replying as the requester', () => {
  it('appends to the thread and moves a solved ticket back to open', async () => {
    const { reference, secret } = await openTicket()
    await SELF.fetch(`https://support.test/tickets/${reference}`, { headers: asLinkHolder(secret) })

    const ticket = await firstRow<{ id: string }>('SELECT id FROM tickets')
    await SELF.fetch(`https://support.test/admin/tickets/${ticket!.id}`, {
      method: 'PATCH',
      headers: await asAgent(),
      body: JSON.stringify({ status: 'solved' }),
    })

    const response = await post(`/tickets/${reference}/messages`, { body: 'It is still happening.' }, asLinkHolder(secret))
    expect(response.status).toBe(201)

    const row = await firstRow<{ status: string }>('SELECT status FROM tickets')
    // Somebody writing on a finished ticket is reopening it; leaving it solved would hide a live
    // conversation from every inbox filter the console has.
    expect(row?.status).toBe('open')
  })
})

describe('the signed-in requester', () => {
  it('claims tickets opened anonymously with the same verified address', async () => {
    await openTicket({ email: 'someone@example.test' })

    const headers = await asRequester({ email: 'someone@example.test' })
    const claim = await post('/me/tickets/claim', {}, headers)
    expect(claim.status).toBe(200)
    expect((await claim.json() as { data: { claimed: number } }).data.claimed).toBe(1)

    const listed = await get('/me/tickets', headers)
    const body = (await listed.json()) as { data: Array<{ reference: string }> }
    expect(body.data.map((row) => row.reference)).toEqual(['FS-1001'])
  })

  it('reads its own ticket without the link, and is recorded as the owner on the way through', async () => {
    const { reference } = await openTicket({ email: 'someone@example.test' })
    const headers = await asRequester({ email: 'someone@example.test', sub: 'visitor-42' })

    expect((await get(`/tickets/${reference}`, headers)).status).toBe(200)

    // The link is made here because it can only be made here: this Worker has no way to ask the auth
    // database whether an address has an account, so a verified token arriving is the whole signal.
    const row = await firstRow<{ requester_user_id: string }>('SELECT requester_user_id FROM tickets')
    expect(row?.requester_user_id).toBe('visitor-42')
  })

  it('cannot read somebody else\'s ticket', async () => {
    const { reference } = await openTicket({ email: 'someone@example.test' })
    const headers = await asRequester({ email: 'stranger@example.test' })
    expect((await get(`/tickets/${reference}`, headers)).status).toBe(404)
  })

  it('does not list a ticket marked as spam', async () => {
    await openTicket({ email: 'someone@example.test' })
    const ticket = await firstRow<{ id: string }>('SELECT id FROM tickets')
    await SELF.fetch(`https://support.test/admin/tickets/${ticket!.id}`, {
      method: 'PATCH',
      headers: await asAgent(),
      body: JSON.stringify({ status: 'spam' }),
    })

    const headers = await asRequester({ email: 'someone@example.test' })
    const listed = await get('/me/tickets', headers)
    expect((await listed.json() as { data: unknown[] }).data).toEqual([])
  })
})

describe('the audit trail', () => {
  it('records the ticket being opened, without the body of it', async () => {
    await openTicket()
    const rows = await allRows<{ event: string; metadata: string }>('SELECT event, metadata FROM audit_logs')
    expect(rows.map((row) => row.event)).toContain('ticket.created')
    // The trail is read out in the console; somebody's support request is not for it.
    expect(rows.map((row) => row.metadata).join()).not.toContain('magic link')
  })
})
