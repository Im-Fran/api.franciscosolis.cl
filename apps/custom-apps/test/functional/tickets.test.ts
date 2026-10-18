import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { todayIn } from '@/services/contracts'
import { createApp, enrollDevice, ingest, ingestJson, panelJson, type Json } from '../helpers/api'
import { sentEmails } from '../helpers/email'
import { publishedNotifications } from '../helpers/notifications'
import { drainTelemetry } from '../helpers/telemetry'

const setup = async (modules = ['support', 'logs', 'crashes']) => {
  const created = await createApp({ modules })
  const device = await enrollDevice(created.id, created.key.key, { app_version: '1.4.0', hostname: 'CAJA-2' })
  return { app: created, device }
}

const open = (appId: string, token: string, body: Json = {}) =>
  ingestJson(appId, '/tickets', { token, body: { subject: 'La impresora no imprime', message: 'Desde la mañana.', name: 'María', email: 'maria@cliente.cl', ...body } })

describe('support tickets', () => {
  it('are opened from the app with the device attached, and land in the panel', async () => {
    const { app, device } = await setup()
    await ingestJson(app.id, '/logs', { token: device.access_token, body: { entries: [{ id: 'l1', level: 'error', message: 'COM3 not responding', target: 'printer', occurred_at: new Date().toISOString() }] } })
    await drainTelemetry()

    const opened = await open(app.id, device.access_token)
    expect(opened.status).toBe(201)
    expect(opened.body.data).toMatchObject({ subject: 'La impresora no imprime', status: 'open', last_message_by: 'requester', unread: 0 })
    expect(opened.body.data).not.toHaveProperty('context')
    expect(sentEmails()).toEqual([])

    const inbox = await panelJson('/v1/tickets?status=active')
    expect(inbox.body.pagination.total).toBe(1)
    const [listed] = inbox.body.data
    expect(listed).toMatchObject({ number: opened.body.data.number, app_name: app.name, installation_name: 'CAJA-2', requester_name: 'María', requester_email: 'maria@cliente.cl', unread: 1, logged_minutes: 0 })
    expect(listed.context.installation).toMatchObject({ name: 'CAJA-2', app_version: '1.4.0', channel: 'stable' })
    expect(listed.context.logs[0]).toContain('COM3 not responding')

    // The creator of the app turned support on, so they hear about it.
    expect(publishedNotifications()).toEqual([
      expect.objectContaining({ type: 'custom_apps.ticket_opened', user: expect.objectContaining({ email: 'fran@franciscosolis.cl' }), url: `/custom-apps/tickets/${listed.id}` }),
    ])
    expect(publishedNotifications()[0]!.data).toMatchObject({ number: listed.number, subject: 'La impresora no imprime', excerpt: 'Desde la mañana.' })

    const detail = (await panelJson(`/v1/tickets/${listed.id}`)).body.data
    expect(detail.messages).toEqual([expect.objectContaining({ author: 'requester', author_name: 'María', body: 'Desde la mañana.' })])
    // Opening it read it.
    expect((await panelJson('/v1/tickets')).body.data[0].unread).toBe(0)
    expect((await panelJson(`/v1/tickets?search=%23${listed.number}`)).body.pagination.total).toBe(1)
    expect((await panelJson('/v1/tickets?search=impresora')).body.pagination.total).toBe(1)
  })

  it('carry the conversation both ways, with the status following it', async () => {
    const { app, device } = await setup()
    const ticket = (await open(app.id, device.access_token)).body.data
    const reply = await panelJson(`/v1/tickets/${ticket.id}/replies`, { method: 'POST', body: { message: 'Revisa el cable USB, por favor.' } })
    expect(reply.status).toBe(201)
    expect(reply.body.data).toMatchObject({ status: 'pending', last_message_by: 'staff' })

    const beat = (await ingestJson(app.id, '/heartbeat', { token: device.access_token, body: {} })).body.data
    expect(beat.sync.support_unread).toBe(1)
    expect((await ingestJson(app.id, '/tickets', { token: device.access_token })).body.data[0]).toMatchObject({ id: ticket.id, unread: 1, status: 'pending' })
    const read = (await ingestJson(app.id, `/tickets/${ticket.id}`, { token: device.access_token })).body.data
    expect(read.messages.map((message: Json) => message.author)).toEqual(['requester', 'staff'])
    expect(read.messages[1]).toMatchObject({ author_name: 'Fran', body: 'Revisa el cable USB, por favor.' })
    expect((await ingestJson(app.id, '/heartbeat', { token: device.access_token, body: {} })).body.data.sync.support_unread).toBe(0)

    const answer = await ingestJson(app.id, `/tickets/${ticket.id}/messages`, { token: device.access_token, body: { message: 'Ya lo cambiamos y sigue igual.' } })
    expect(answer.body.data.status).toBe('open')
    expect(publishedNotifications().map((event) => event.type)).toEqual(['custom_apps.ticket_opened', 'custom_apps.ticket_message'])

    await panelJson(`/v1/tickets/${ticket.id}/replies`, { method: 'POST', body: { message: 'Listo, cambiamos el driver.', status: 'resolved' } })
    let shown = (await panelJson(`/v1/tickets/${ticket.id}`)).body.data
    expect(shown).toMatchObject({ status: 'resolved', resolved_by: 'fran@franciscosolis.cl' })
    // A message on a resolved ticket reopens it; on a closed one it is refused.
    await ingestJson(app.id, `/tickets/${ticket.id}/messages`, { token: device.access_token, body: { message: 'Volvió a pasar.' } })
    shown = (await panelJson(`/v1/tickets/${ticket.id}`)).body.data
    expect(shown).toMatchObject({ status: 'open', resolved_at: null })
    await panelJson(`/v1/tickets/${ticket.id}`, { method: 'PATCH', body: { status: 'closed' } })
    expect((await ingest(app.id, `/tickets/${ticket.id}/messages`, { token: device.access_token, body: { message: 'hola' } })).status).toBe(409)

    const audit = await env.DB.prepare("SELECT event FROM audit_logs WHERE resource_type = 'ticket' AND resource_id = ? ORDER BY created_at, rowid").bind(ticket.id).all<{ event: string }>()
    expect(audit.results.map((row) => row.event)).toEqual(['ticket.opened', 'ticket.replied', 'ticket.replied', 'ticket.status_changed'])
  })

  it('stay with the installation that opened them', async () => {
    const { app, device } = await setup()
    const other = await enrollDevice(app.id, app.key.key)
    const ticket = (await open(app.id, device.access_token)).body.data
    expect((await ingest(app.id, `/tickets/${ticket.id}`, { token: other.access_token })).status).toBe(404)
    expect((await ingest(app.id, `/tickets/${ticket.id}/messages`, { token: other.access_token, body: { message: 'x' } })).status).toBe(404)
    expect((await ingestJson(app.id, '/tickets', { token: other.access_token })).body.data).toEqual([])
  })

  it('are limited per installation, numbered in order, and need the module', async () => {
    const { app, device } = await setup()
    const numbers: number[] = []
    for (let i = 0; i < 5; i += 1) numbers.push((await open(app.id, device.access_token, { include_diagnostics: false })).body.data.number)
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b))
    expect(new Set(numbers).size).toBe(5)
    expect((await open(app.id, device.access_token)).status).toBe(429)

    const bare = await createApp({ company_id: app.company_id, modules: ['metrics'] })
    const other = await enrollDevice(bare.id, bare.key.key)
    expect((await ingest(bare.id, '/tickets', { token: other.access_token, body: { subject: 'x', message: 'y' } })).status).toBe(403)
    expect((await ingestJson(bare.id, '/heartbeat', { token: other.access_token, body: {} })).body.data.sync.support_unread).toBeNull()
    const paths = Object.keys(((await ingestJson(bare.id, '/openapi.json')).body as { paths: Record<string, unknown> }).paths)
    expect(paths.some((path) => path.startsWith('/tickets'))).toBe(false)
  })

  it('take the hours logged against them, and can be taken over', async () => {
    const { app, device } = await setup()
    const ticket = (await open(app.id, device.access_token)).body.data
    const logged = await panelJson(`/v1/apps/${app.id}/work-logs`, {
      method: 'POST',
      body: { kind: 'support', description: 'Diagnóstico remoto', occurred_on: todayIn(), minutes: 45, ticket_id: ticket.id },
    })
    expect(logged.status).toBe(201)
    expect(logged.body.data).toMatchObject({ ticket_id: ticket.id, ticket_number: ticket.number })
    const detail = (await panelJson(`/v1/tickets/${ticket.id}`)).body.data
    expect(detail).toMatchObject({ logged_minutes: 45 })
    expect(detail.work_logs).toEqual([expect.objectContaining({ minutes: 45, description: 'Diagnóstico remoto' })])

    const otherCompany = (await panelJson('/v1/companies', { method: 'POST', body: { legal_name: 'Otra SpA', is_company: true } })).body.data
    const foreign = await createApp({ company_id: otherCompany.id })
    expect((await panelJson(`/v1/apps/${foreign.id}/work-logs`, { method: 'POST', body: { kind: 'support', description: 'x', occurred_on: todayIn(), minutes: 5, ticket_id: ticket.id } })).status).toBe(422)

    const taken = await panelJson(`/v1/apps/${app.id}/support/assignee`, { method: 'POST', as: { sub: 'admin-2', email: 'otro@franciscosolis.cl' } })
    expect(taken.body.data).toEqual({ app_id: app.id, support_assignee_email: 'otro@franciscosolis.cl' })
    expect((await panelJson(`/v1/apps/${app.id}`)).body.data.support_assignee_email).toBe('otro@franciscosolis.cl')
    await ingestJson(app.id, `/tickets/${ticket.id}/messages`, { token: device.access_token, body: { message: '¿Novedades?' } })
    expect(publishedNotifications().at(-1)).toMatchObject({ type: 'custom_apps.ticket_message', user: { id: 'admin-2', email: 'otro@franciscosolis.cl' } })
  })

  it('show in the overview', async () => {
    const { app, device } = await setup()
    await open(app.id, device.access_token)
    const second = (await open(app.id, device.access_token)).body.data
    await panelJson(`/v1/tickets/${second.id}/replies`, { method: 'POST', body: { message: 'ok' } })
    expect((await panelJson('/v1/overview')).body.data.tickets).toEqual({ open: 1, pending: 1, unread: 1 })
  })
})
