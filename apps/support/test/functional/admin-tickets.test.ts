import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { allRows, clearDatabase, countRows, firstRow } from '../helpers/db'
import { asAgent } from '../helpers/tokens'

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
  const body = (await response.json()) as { data: { reference: string } }
  const row = await firstRow<{ id: string }>('SELECT id FROM tickets ORDER BY number DESC')
  return { id: row!.id, reference: body.data.reference }
}

beforeEach(clearDatabase)

describe('GET /admin/tickets', () => {
  it('lists tickets, most recently active first', async () => {
    await openTicket({ subject: 'First' })
    await openTicket({ subject: 'Second', email: 'other@example.test' })

    const response = await call('/admin/tickets', { headers: await asAgent() })
    const body = (await response.json()) as { data: Array<{ subject: string }> }
    expect(body.data.map((row) => row.subject)).toEqual(['Second', 'First'])
  })

  it('filters by status', async () => {
    const solved = await openTicket({ subject: 'Already handled' })
    await openTicket({ subject: 'Still open', email: 'other@example.test' })
    const headers = await asAgent()
    await call(`/admin/tickets/${solved.id}`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'solved' }) })

    const response = await call('/admin/tickets?status=solved', { headers })
    const body = (await response.json()) as { data: Array<{ subject: string }> }
    expect(body.data.map((row) => row.subject)).toEqual(['Already handled'])
  })

  it('orders stably when two tickets were touched in the same second', async () => {
    await openTicket({ subject: 'First' })
    await openTicket({ subject: 'Second', email: 'other@example.test' })
    const headers = await asAgent()

    // `updated_at` is whole seconds, so without the tie-break on the ticket number these two have no
    // defined order and the inbox reshuffles itself between reads.
    const pages = await Promise.all([
      call('/admin/tickets', { headers }),
      call('/admin/tickets', { headers }),
    ])
    const [a, b] = await Promise.all(pages.map(async (p) => ((await p.json()) as { data: Array<{ subject: string }> }).data.map((r) => r.subject)))
    expect(a).toEqual(['Second', 'First'])
    expect(b).toEqual(a)
  })

  it('answers an unknown label slug with an empty list rather than everything', async () => {
    await openTicket()
    const response = await call('/admin/tickets?label=does-not-exist', { headers: await asAgent() })
    expect((await response.json() as { data: unknown[] }).data).toEqual([])
  })
})

describe('GET /admin/tickets/:id', () => {
  it('accepts a reference as well as an id, because people paste references', async () => {
    const { id, reference } = await openTicket()
    const headers = await asAgent()

    const byId = await call(`/admin/tickets/${id}`, { headers })
    const byReference = await call(`/admin/tickets/${reference}`, { headers })

    expect(byId.status).toBe(200)
    expect(byReference.status).toBe(200)
    expect((await byReference.json() as { data: { id: string } }).data.id).toBe(id)
  })

  it('404s on an unknown id', async () => {
    expect((await call(`/admin/tickets/${crypto.randomUUID()}`, { headers: await asAgent() })).status).toBe(404)
  })
})

describe('PATCH /admin/tickets/:id', () => {
  it('edits the subject and writes it onto the timeline', async () => {
    const { id } = await openTicket()
    const response = await call(`/admin/tickets/${id}`, {
      method: 'PATCH',
      headers: await asAgent(),
      body: JSON.stringify({ subject: 'Magic link never arrives' }),
    })
    expect(response.status).toBe(200)

    const events = await allRows<{ event: string; metadata: string }>('SELECT event, metadata FROM ticket_events')
    const renamed = events.find((row) => row.event === 'subject_changed')
    expect(renamed).toBeDefined()
    expect(JSON.parse(renamed!.metadata)).toMatchObject({ from: 'Cannot sign in', to: 'Magic link never arrives' })
  })

  it('stamps solved_at once and keeps it through a later change', async () => {
    const { id } = await openTicket()
    const headers = await asAgent()

    await call(`/admin/tickets/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'solved' }) })
    const first = await firstRow<{ solved_at: number }>('SELECT solved_at FROM tickets')

    await call(`/admin/tickets/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'open' }) })
    await call(`/admin/tickets/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'solved' }) })
    const second = await firstRow<{ solved_at: number }>('SELECT solved_at FROM tickets')

    // It records when the thing happened, not when somebody last touched a dropdown.
    expect(second?.solved_at).toBe(first?.solved_at)
  })

  it('leaves a field out of the body alone and clears one sent as null', async () => {
    const { id } = await openTicket({ name: 'Someone' })
    const headers = await asAgent()

    await call(`/admin/tickets/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ priority: 'high' }) })
    expect((await firstRow<{ requester_name: string }>('SELECT requester_name FROM tickets'))?.requester_name).toBe('Someone')

    await call(`/admin/tickets/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ requester_name: null }) })
    expect((await firstRow<{ requester_name: string | null }>('SELECT requester_name FROM tickets'))?.requester_name).toBeNull()
  })
})

describe('POST /admin/tickets/:id/messages', () => {
  it('stamps the first response once, and only on a public reply', async () => {
    const { id } = await openTicket()
    const headers = await asAgent()

    await call(`/admin/tickets/${id}/messages`, { method: 'POST', headers, body: JSON.stringify({ body: 'Internal thought', kind: 'note' }) })
    // A note is the team talking to itself, not an answer to anybody.
    expect((await firstRow<{ first_response_at: number | null }>('SELECT first_response_at FROM tickets'))?.first_response_at).toBeNull()

    await call(`/admin/tickets/${id}/messages`, { method: 'POST', headers, body: JSON.stringify({ body: 'We are on it' }) })
    const stamped = await firstRow<{ first_response_at: number }>('SELECT first_response_at FROM tickets')
    expect(stamped?.first_response_at).toBeGreaterThan(0)

    await call(`/admin/tickets/${id}/messages`, { method: 'POST', headers, body: JSON.stringify({ body: 'Any news?' }) })
    expect((await firstRow<{ first_response_at: number }>('SELECT first_response_at FROM tickets'))?.first_response_at).toBe(
      stamped?.first_response_at,
    )
  })

  it('gives every message a distinct ordinal, which is what the digest window is defined on', async () => {
    const { id } = await openTicket()
    const headers = await asAgent()
    await Promise.all(
      ['one', 'two', 'three'].map((body) =>
        call(`/admin/tickets/${id}/messages`, { method: 'POST', headers, body: JSON.stringify({ body }) }),
      ),
    )

    const rows = await allRows<{ seq: number }>('SELECT seq FROM ticket_messages ORDER BY seq')
    // Timestamps here are whole seconds, so three messages written in the same second would be
    // unorderable without this.
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4])
  })
})

describe('assignment', () => {
  it('assigns a ticket, takes it out of the untouched pile and puts the agent on it quietly', async () => {
    const { id } = await openTicket()
    const headers = await asAgent()

    const response = await call(`/admin/tickets/${id}/assignee`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ email: 'fran@franciscosolis.cl' }),
    })
    expect(response.status).toBe(200)

    const ticket = await firstRow<{ assignee_email: string; status: string }>('SELECT assignee_email, status FROM tickets')
    expect(ticket?.assignee_email).toBe('fran@franciscosolis.cl')
    expect(ticket?.status).toBe('open')

    const participant = await firstRow<{ notify_email: number }>(
      "SELECT notify_email FROM ticket_participants WHERE role = 'agent'",
    )
    // Agents work the queue in the console; they do not want a mailbox copy of every thread.
    expect(participant?.notify_email).toBe(0)
  })

  it('clears an assignment with a null email', async () => {
    const { id } = await openTicket()
    const headers = await asAgent()
    await call(`/admin/tickets/${id}/assignee`, { method: 'PUT', headers, body: JSON.stringify({ email: 'fran@franciscosolis.cl' }) })
    await call(`/admin/tickets/${id}/assignee`, { method: 'PUT', headers, body: JSON.stringify({ email: null }) })

    expect((await firstRow<{ assignee_email: string | null }>('SELECT assignee_email FROM tickets'))?.assignee_email).toBeNull()
  })
})

describe('participants', () => {
  it('adds a watcher at the current head, so they are not mailed a conversation they missed', async () => {
    const { id } = await openTicket()
    const headers = await asAgent()
    await call(`/admin/tickets/${id}/messages`, { method: 'POST', headers, body: JSON.stringify({ body: 'A reply' }) })

    const response = await call(`/admin/tickets/${id}/participants`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: 'colleague@example.test' }),
    })
    expect(response.status).toBe(201)

    const row = await firstRow<{ last_notified_seq: number }>(
      "SELECT last_notified_seq FROM ticket_participants WHERE email = 'colleague@example.test'",
    )
    expect(row?.last_notified_seq).toBe(2)
  })

  it('refuses the same address twice', async () => {
    const { id } = await openTicket()
    const headers = await asAgent()
    const body = JSON.stringify({ email: 'colleague@example.test' })
    await call(`/admin/tickets/${id}/participants`, { method: 'POST', headers, body })
    expect((await call(`/admin/tickets/${id}/participants`, { method: 'POST', headers, body })).status).toBe(409)
  })

  it('refuses to remove the person whose ticket it is', async () => {
    const { id } = await openTicket()
    const headers = await asAgent()
    const requester = await firstRow<{ id: string }>("SELECT id FROM ticket_participants WHERE role = 'requester'")

    const response = await call(`/admin/tickets/${id}/participants/${requester!.id}`, { method: 'DELETE', headers })
    expect(response.status).toBe(409)
  })
})

describe('labels', () => {
  it('applies a seeded label and takes it off again', async () => {
    const { id } = await openTicket()
    const headers = await asAgent()
    const label = await firstRow<{ id: string }>("SELECT id FROM labels WHERE slug = 'bug'")

    expect((await call(`/admin/tickets/${id}/labels/${label!.id}`, { method: 'POST', headers })).status).toBe(204)
    expect(await countRows('ticket_labels')).toBe(1)

    // Applying it twice is not an error; a console that re-sends the click should not 409.
    expect((await call(`/admin/tickets/${id}/labels/${label!.id}`, { method: 'POST', headers })).status).toBe(204)
    expect(await countRows('ticket_labels')).toBe(1)

    expect((await call(`/admin/tickets/${id}/labels/${label!.id}`, { method: 'DELETE', headers })).status).toBe(204)
    expect(await countRows('ticket_labels')).toBe(0)
  })

  it('serves the seeded catalogue in Spanish when the ticket is in Spanish', async () => {
    const { id } = await openTicket({ locale: 'es' })
    const headers = await asAgent()
    const label = await firstRow<{ id: string }>("SELECT id FROM labels WHERE slug = 'billing'")
    await call(`/admin/tickets/${id}/labels/${label!.id}`, { method: 'POST', headers })

    const response = await call(`/admin/tickets/${id}`, { headers })
    const body = (await response.json()) as { data: { labels: Array<{ name: string }> } }
    expect(body.data.labels[0]?.name).toBe('Facturación')
  })
})

describe('DELETE /admin/tickets/:id', () => {
  it('takes the whole thread with it', async () => {
    const { id } = await openTicket({ cc: ['colleague@example.test'] })
    const headers = await asAgent()
    await call(`/admin/tickets/${id}/messages`, { method: 'POST', headers, body: JSON.stringify({ body: 'A reply' }) })

    expect((await call(`/admin/tickets/${id}`, { method: 'DELETE', headers })).status).toBe(204)

    expect(await countRows('tickets')).toBe(0)
    expect(await countRows('ticket_messages')).toBe(0)
    expect(await countRows('ticket_participants')).toBe(0)
    expect(await countRows('ticket_events')).toBe(0)
  })
})
