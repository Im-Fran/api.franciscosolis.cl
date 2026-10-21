import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { addDays } from '@/lib/hours'
import { zonedParts } from '@/lib/time'
import { runContracts, todayIn } from '@/services/contracts'
import { runMaintenances } from '@/services/maintenances'
import { createApp, createCompany, enrollDevice, ingestJson, panel, panelJson, type Json } from '../helpers/api'
import { sentEmails } from '../helpers/email'
import { publishedNotifications } from '../helpers/notifications'

/*
 * Scheduled maintenances, end to end. The windows are offered on the real clock (a window must start
 * in the future), and everything after the send is driven by calling the cron with explicit instants
 * relative to them — never by waiting, and never by assuming where an hour boundary falls.
 */

const HOUR = 3_600_000

/** A valid RUT for any body, so each test can have companies of its own. */
const rut = (body: number) => {
  let sum = 0
  let factor = 2
  for (const digit of String(body).split('').reverse()) {
    sum += Number(digit) * factor
    factor = factor === 7 ? 2 : factor + 1
  }
  const check = 11 - (sum % 11)
  return `${body}-${check === 11 ? '0' : check === 10 ? 'K' : check}`
}
let rutSeed = 71_000_000

type ContactSpec = { email: string; roles?: string[]; primary?: boolean }

const addContact = async (companyId: string, spec: ContactSpec) => {
  const contact = (await panelJson('/v1/contacts', { method: 'POST', body: { name: spec.email.split('@')[0], emails: [spec.email] } })).body.data
  const linked = await panel(`/v1/companies/${companyId}/contacts/${contact.id}`, { method: 'PUT', body: { roles: spec.roles ?? [], is_primary: spec.primary ?? false } })
  if (linked.status !== 200) throw new Error(`linking a contact answered ${linked.status}`)
}

const setup = async (options: { modules?: string[]; contacts?: ContactSpec[]; app?: Json } = {}) => {
  const company = await createCompany({ legal_name: `Cliente ${rutSeed} SpA`, trade_name: `Cliente ${rutSeed}`, rut: rut(rutSeed++) })
  const app = await createApp({ company_id: company.id, name: 'POS Andes', modules: options.modules ?? ['messages', 'updates'], ...options.app })
  for (const contact of options.contacts ?? [{ email: `aprobador-${rutSeed}@cliente.cl`, roles: ['maintenance_approver'] }]) await addContact(company.id, contact)
  return { company, app }
}

const at = (offsetHours: number, from = Date.now()) => new Date(from + offsetHours * HOUR)

const createMaintenance = async (appId: string, body: Json = {}) => {
  const response = await panelJson(`/v1/apps/${appId}/maintenances`, {
    method: 'POST',
    body: { title: 'Actualización a la 1.1', description: 'Se instala la versión 1.1.\nLas cajas muestran un aviso durante la ventana.', estimated_minutes: 60, ...body },
  })
  if (response.status !== 201) throw new Error(`create answered ${response.status}: ${JSON.stringify(response.body)}`)
  return response.body.data as Json
}

const addWindow = (id: string, startsAt: Date, body: Json = {}) => panelJson(`/v1/maintenances/${id}/windows`, { method: 'POST', body: { starts_at: startsAt.toISOString(), ...body } })

const send = async (id: string) => {
  const response = await panelJson(`/v1/maintenances/${id}/send`, { method: 'POST' })
  if (response.status !== 200) throw new Error(`send answered ${response.status}: ${JSON.stringify(response.body)}`)
  return response.body.data as Json
}

const LINK = /https:\/\/franciscosolis\.cl\/mantencion\/(mnt_[A-Za-z0-9_-]+)/
const tokensIn = (emails = sentEmails()) => emails.map((email) => LINK.exec(email.text)?.[1]).filter((token): token is string => Boolean(token))

/** The public routes, as the website calls them: no Authorization, an IP of their own. */
const publicJson = async (token: string, path = '', body?: Json, ip = `192.0.2.${Math.floor(Math.random() * 250) + 1}`) => {
  const response = await SELF.fetch(`https://api.franciscosolis.cl/v1/public/maintenances/${token}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Json }
}

const get = async (id: string) => (await panelJson(`/v1/maintenances/${id}`)).body.data as Json

const audit = async (id: string, event: string) =>
  env.DB.prepare('SELECT actor_email, metadata FROM audit_logs WHERE resource_type = ? AND resource_id = ? AND event = ? ORDER BY created_at DESC, rowid DESC').bind('maintenance', id, event).first<{ actor_email: string | null; metadata: string }>()

/** A planned maintenance with two windows, sent: the first offered (position 0) is `first`, the other `second`. */
const sentMaintenance = async (appId: string, first: Date, second: Date, body: Json = {}): Promise<Json> => {
  const maintenance = await createMaintenance(appId, body)
  expect((await addWindow(maintenance.id, first)).status).toBe(201)
  expect((await addWindow(maintenance.id, second)).status).toBe(201)
  const sentAt = Date.now()
  const data = await send(maintenance.id)
  return { ...data, sentAt }
}

/* ── Releases, as CI uploads them ─────────────────────────────────────────── */

const toBase64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)))

const withReleases = async (appId: string) => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const publicKey = toBase64((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
  expect((await panelJson(`/v1/apps/${appId}`, { method: 'PATCH', body: { release_public_key: publicKey } })).status).toBe(200)
  const ci = (await panelJson(`/v1/apps/${appId}/ci-tokens`, { method: 'POST', body: {} })).body.data
  return async (version: string) => {
    const bytes = new TextEncoder().encode(`build ${version} `.repeat(64))
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const signature = toBase64(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, digest))
    const query = new URLSearchParams({ version, platform: 'windows', arch: 'x86_64', filename: 'pos-setup.msi' })
    const response = await SELF.fetch(`https://api.franciscosolis.cl/v1/apps/${appId}/releases/upload?${query}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ci.token}`, 'Content-Type': 'application/x-msi', 'Content-Length': String(bytes.byteLength), 'X-Signature': signature },
      body: bytes,
    })
    const body = (await response.json()) as Json
    if (response.status !== 201) throw new Error(`upload answered ${response.status}: ${JSON.stringify(body)}`)
    return body.data as Json
  }
}

/** A device's report, filed at `when` on the simulated clock: it reported during the window. */
const report = async (appId: string, token: string, releaseId: string, status: string, when: Date) => {
  expect((await ingestJson(appId, `/updates/${releaseId}/report`, { token, body: { status } })).status).toBe(202)
  await env.DB.prepare('UPDATE release_reports SET created_at = ? WHERE id = (SELECT MAX(id) FROM release_reports)').bind(Math.floor(when.getTime() / 1000)).run()
}

/* ── Planning and sending ─────────────────────────────────────────────────── */

describe('planning a maintenance', () => {
  it('takes windows that fit, reorders them, suggests more and refuses what cannot be offered', async () => {
    const { app } = await setup()
    const maintenance = await createMaintenance(app.id, { estimated_minutes: 120 })
    expect(maintenance).toMatchObject({ app_id: app.id, app_name: 'POS Andes', kind: 'normal', status: 'draft', all_installations: true, sends: 0, windows: [], chosen_window: null, created_by: 'fran@franciscosolis.cl' })

    const first = await addWindow(maintenance.id, at(72))
    expect(first.status).toBe(201)
    expect(first.body.data[0]).toMatchObject({ source: 'manual', position: 0, chosen: false })
    // `ends_at` defaults to the estimated duration.
    expect(Date.parse(first.body.data[0].ends_at) - Date.parse(first.body.data[0].starts_at)).toBe(2 * HOUR)
    expect((await addWindow(maintenance.id, at(73))).status).toBe(409)
    expect((await addWindow(maintenance.id, at(100), { ends_at: at(101).toISOString() })).status).toBe(422)
    expect((await addWindow(maintenance.id, at(-1))).status).toBe(422)
    const second = await addWindow(maintenance.id, at(96), { source: 'suggested' })
    const secondId = second.body.data.find((window: Json) => window.source === 'suggested').id
    const reordered = await panelJson(`/v1/maintenances/${maintenance.id}/windows/${secondId}`, { method: 'PATCH', body: { position: 0 } })
    expect(reordered.body.data.map((window: Json) => [window.id, window.position])).toEqual([
      [secondId, 0],
      [first.body.data[0].id, 1],
    ])
    // A longer estimate must still fit every window.
    expect((await panelJson(`/v1/maintenances/${maintenance.id}`, { method: 'PATCH', body: { estimated_minutes: 180 } })).status).toBe(422)

    const suggested = await panelJson(`/v1/maintenances/${maintenance.id}/windows/suggest`)
    expect(suggested.status).toBe(200)
    expect(suggested.body.data).toMatchObject({ timezone: 'America/Santiago', estimated_minutes: 120, scored_hours: 2, min_lead_hours: 24, days: 14, operating_hours_applied: false })
    const suggestions = suggested.body.data.suggestions as Json[]
    expect(suggestions).toHaveLength(5)
    const offered = reordered.body.data.map((window: Json) => [Date.parse(window.starts_at), Date.parse(window.ends_at)])
    for (const suggestion of suggestions) {
      const start = Date.parse(suggestion.starts_at)
      const end = Date.parse(suggestion.ends_at)
      expect(start).toBeGreaterThanOrEqual(Date.now() + 24 * HOUR - 60_000)
      expect(end - start).toBe(2 * HOUR)
      // No telemetry: everything is unused, and nothing overlaps what is already offered.
      expect(suggestion.expected_active_seconds).toBe(0)
      for (const [from, to] of offered) expect(start >= to! || end <= from!).toBe(true)
    }
    // Suggestions are not saved.
    expect((await get(maintenance.id)).windows).toHaveLength(2)
    expect((await panelJson(`/v1/maintenances/${maintenance.id}/windows/suggest`, { method: 'POST' })).status).toBe(200)

    const created = await audit(maintenance.id, 'maintenance.window_added')
    expect(created?.actor_email).toBe('fran@franciscosolis.cl')
  })

  it('takes a release of the same app and installations on its line only', async () => {
    const { app } = await setup()
    const upload = await withReleases(app.id)
    const release = await upload('1.1.0')
    const windowsDevice = await enrollDevice(app.id, app.key.key)
    const linuxDevice = await enrollDevice(app.id, app.key.key, { platform: 'linux' })
    const ok = await panelJson(`/v1/apps/${app.id}/maintenances`, { method: 'POST', body: { title: 'x', description: 'y', estimated_minutes: 30, release_id: release.id, installation_ids: [windowsDevice.installation_id] } })
    expect(ok.status).toBe(201)
    expect(ok.body.data).toMatchObject({ release: { id: release.id, version: '1.1.0', status: 'draft' }, installation_ids: [windowsDevice.installation_id], all_installations: false })
    expect((await panelJson(`/v1/apps/${app.id}/maintenances`, { method: 'POST', body: { title: 'x', description: 'y', estimated_minutes: 30, release_id: release.id, installation_ids: [linuxDevice.installation_id] } })).status).toBe(422)
    const other = await setup()
    expect((await panelJson(`/v1/apps/${other.app.id}/maintenances`, { method: 'POST', body: { title: 'x', description: 'y', estimated_minutes: 30, release_id: release.id } })).status).toBe(422)
    expect((await panelJson(`/v1/apps/${app.id}/maintenances`, { method: 'POST', body: { title: 'x', description: 'y', estimated_minutes: 5 } })).status).toBe(400)
    const listed = await panelJson(`/v1/maintenances/${ok.body.data.id}/installations`)
    expect(listed.body.data).toEqual([expect.objectContaining({ id: windowsDevice.installation_id, on_release_line: true })])
  })
})

describe('sending for approval', () => {
  it('emails each approver a link of their own, and locks the maintenance', async () => {
    const { app } = await setup({
      contacts: [
        { email: 'ops@cliente.cl', roles: ['maintenance_approver'] },
        { email: 'jefe@cliente.cl', roles: ['owner', 'maintenance_approver'] },
        { email: 'principal@cliente.cl', roles: ['technical'], primary: true },
      ],
    })
    const sent = await sentMaintenance(app.id, at(72), at(96))
    expect(sent).toMatchObject({ status: 'pending_approval', sends: 1, last_sent_at: expect.any(String) })
    expect(sent.recipients.sort()).toEqual(['jefe@cliente.cl', 'ops@cliente.cl'])
    expect(sent.link_expires_at).toBe(sent.windows[0].starts_at)

    const emails = sentEmails()
    expect(emails).toHaveLength(2)
    expect(emails.map((email) => email.to).sort()).toEqual([['jefe@cliente.cl'], ['ops@cliente.cl']])
    expect(emails[0]!.subject).toBe('Elige una ventana para una mantención: “Actualización a la 1.1”')
    expect(emails[0]!.text).toContain('Se instala la versión 1.1.')
    expect(emails[0]!.text).toContain('1 hora')
    expect(emails[0]!.text).toContain('(hora de Santiago)')
    const tokens = tokensIn()
    expect(tokens).toHaveLength(2)
    expect(new Set(tokens).size).toBe(2)
    // Only the hash is stored.
    const stored = await env.DB.prepare('SELECT token_hash FROM maintenance_links WHERE maintenance_id = ?').bind(sent.id).all<{ token_hash: string }>()
    expect(stored.results.map((row) => row.token_hash)).not.toContain(tokens[0])

    expect((await panelJson(`/v1/maintenances/${sent.id}`, { method: 'PATCH', body: { title: 'Otro' } })).status).toBe(409)
    expect((await addWindow(sent.id, at(120))).status).toBe(409)
    expect((await panelJson(`/v1/maintenances/${sent.id}/send`, { method: 'POST' })).status).toBe(409)
    expect((await panelJson(`/v1/maintenances/${sent.id}`, { method: 'DELETE' })).status).toBe(409)
    const row = await audit(sent.id, 'maintenance.sent')
    expect(row?.actor_email).toBe('fran@franciscosolis.cl')
    expect(JSON.parse(row!.metadata)).toMatchObject({ send: 1, windows: 2 })
  })

  it('falls back to the primary contact, then to anyone with an address', async () => {
    const primary = await setup({ contacts: [{ email: 'a@uno.cl', roles: ['billing'] }, { email: 'b@uno.cl', primary: true }] })
    expect((await sentMaintenance(primary.app.id, at(72), at(96))).recipients).toEqual(['b@uno.cl'])
    const anyone = await setup({ contacts: [{ email: 'c@dos.cl', roles: ['technical'] }] })
    expect((await sentMaintenance(anyone.app.id, at(72), at(96))).recipients).toEqual(['c@dos.cl'])
    const nobody = await setup({ contacts: [] })
    const maintenance = await createMaintenance(nobody.app.id)
    await addWindow(maintenance.id, at(72))
    expect((await panelJson(`/v1/maintenances/${maintenance.id}/send`, { method: 'POST' })).status).toBe(422)
    // Nothing offered, nothing to send.
    const empty = await createMaintenance(primary.app.id)
    expect((await panelJson(`/v1/maintenances/${empty.id}/send`, { method: 'POST' })).status).toBe(422)
  })
})

/* ── The approval page ────────────────────────────────────────────────────── */

describe('the approval link', () => {
  it('shows the request without a login and approves one window, once', async () => {
    const { app } = await setup({ contacts: [{ email: 'ops@cliente.cl', roles: ['maintenance_approver'] }] })
    const sent = await sentMaintenance(app.id, at(72), at(96))
    const [token] = tokensIn()
    const shown = await publicJson(token!)
    expect(shown.status).toBe(200)
    expect(shown.body.data).toMatchObject({
      title: 'Actualización a la 1.1',
      estimated_minutes: 60,
      app_name: 'POS Andes',
      company_name: expect.stringMatching(/^Cliente /),
      status: 'pending_approval',
      state: 'open',
      answerable: true,
      outcome: null,
    })
    expect(shown.body.data.windows).toHaveLength(2)
    expect(shown.body.data.windows[0]).toMatchObject({ id: sent.windows[0].id, available: true })
    // Nothing about who it went to, nor anything internal beyond the windows.
    expect(JSON.stringify(shown.body)).not.toContain('ops@cliente.cl')
    expect(JSON.stringify(shown.body)).not.toContain(app.id)

    expect((await publicJson('mnt_short')).status).toBe(404)
    expect((await publicJson(`mnt_${'A'.repeat(43)}`)).status).toBe(404)
    expect((await publicJson(token!, '/approve', { window_id: crypto.randomUUID() })).status).toBe(422)

    sentEmails().length = 0
    const approved = await publicJson(token!, '/approve', { window_id: sent.windows[1].id, name: 'Olga Pérez' })
    expect(approved.status).toBe(200)
    expect(approved.body.data).toMatchObject({ state: 'answered', answerable: false, status: 'scheduled', outcome: { decision: 'approved', window: { id: sent.windows[1].id }, answered_here: true } })

    const after = await get(sent.id)
    expect(after).toMatchObject({ status: 'scheduled', auto_applied: false, chosen_window: { id: sent.windows[1].id, chosen: true }, approved_by: 'ops@cliente.cl', responded_by_name: 'Olga Pérez' })
    expect(sentEmails().map((email) => email.subject)).toEqual(['Mantención confirmada: “Actualización a la 1.1”'])
    expect(sentEmails()[0]!.text).toContain('Olga Pérez (ops@cliente.cl) aprobó la mantención de POS Andes')
    expect(publishedNotifications()).toEqual([
      expect.objectContaining({
        type: 'custom_apps.maintenance_approved',
        user: { id: 'admin-1', email: 'fran@franciscosolis.cl' },
        url: `/custom-apps/maintenances/${sent.id}`,
        data: expect.objectContaining({ title: 'Actualización a la 1.1', app_name: 'POS Andes', approved_by: 'Olga Pérez (ops@cliente.cl)', window: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}–\d{2}:\d{2}$/) }),
      }),
    ])
    const row = await audit(sent.id, 'maintenance.approved')
    expect(row?.actor_email).toBe('ops@cliente.cl')
    expect(JSON.parse(row!.metadata)).toMatchObject({ via: 'approval_link', name: 'Olga Pérez', window: { id: sent.windows[1].id } })

    // Answered: it reads, and it answers nothing more.
    expect(await publicJson(token!, '/approve', { window_id: sent.windows[0].id })).toMatchObject({ status: 410, body: { state: 'answered' } })
    expect(await publicJson(token!, '/reject', { reason: 'No' })).toMatchObject({ status: 410, body: { state: 'answered' } })
    expect((await publicJson(token!)).body.data).toMatchObject({ state: 'answered', outcome: { decision: 'approved' } })
  })

  it('closes every other link once one answers', async () => {
    const { app } = await setup({ contacts: [{ email: 'a@cliente.cl', roles: ['maintenance_approver'] }, { email: 'b@cliente.cl', roles: ['maintenance_approver'] }] })
    const sent = await sentMaintenance(app.id, at(72), at(96))
    const [first, second] = tokensIn()
    expect((await publicJson(first!, '/approve', { window_id: sent.windows[0].id })).status).toBe(200)
    expect(await publicJson(second!, '/approve', { window_id: sent.windows[1].id })).toMatchObject({ status: 410, body: { state: 'closed' } })
    expect((await publicJson(second!)).body.data).toMatchObject({ state: 'closed', outcome: { decision: 'approved', answered_here: false } })
  })

  it('sends a rejection back to draft with its reason, to be offered again', async () => {
    const { app } = await setup({ contacts: [{ email: 'ops@cliente.cl', roles: ['maintenance_approver'] }] })
    const sent = await sentMaintenance(app.id, at(72), at(96))
    const [token] = tokensIn()
    expect((await publicJson(token!, '/reject', {})).status).toBe(400)
    expect((await publicJson(token!, '/reject', { reason: '   ' })).status).toBe(400)
    const rejected = await publicJson(token!, '/reject', { reason: 'Ese día hacemos inventario.' })
    expect(rejected.status).toBe(200)
    expect(rejected.body.data).toMatchObject({ state: 'answered', status: 'draft', outcome: { decision: 'rejected', rejection_reason: 'Ese día hacemos inventario.' } })
    expect(await get(sent.id)).toMatchObject({ status: 'draft', rejected: true, rejection_reason: 'Ese día hacemos inventario.', approved_by: null, responded_by: 'ops@cliente.cl' })
    expect(publishedNotifications()).toEqual([expect.objectContaining({ type: 'custom_apps.maintenance_rejected', data: expect.objectContaining({ reason: 'Ese día hacemos inventario.', rejected_by: 'ops@cliente.cl' }) })])
    expect((await audit(sent.id, 'maintenance.rejected'))?.actor_email).toBe('ops@cliente.cl')

    // A draft again: adjusted and sent anew, with a new link; the old one stays answered.
    expect((await panelJson(`/v1/maintenances/${sent.id}/windows/${sent.windows[0].id}`, { method: 'DELETE' })).status).toBe(200)
    sentEmails().length = 0
    expect(await send(sent.id)).toMatchObject({ status: 'pending_approval', sends: 1, rejected: false })
    const [fresh] = tokensIn()
    expect(fresh).not.toBe(token)
    expect((await publicJson(fresh!)).body.data).toMatchObject({ state: 'open', windows: [expect.objectContaining({ id: sent.windows[1].id })] })
    expect((await publicJson(token!)).body.data.state).toBe('answered')
  })

  it('is limited per address', async () => {
    const { app } = await setup()
    await sentMaintenance(app.id, at(72), at(96))
    const [token] = tokensIn()
    const statuses: number[] = []
    for (let attempt = 0; attempt < 31; attempt += 1) statuses.push((await publicJson(token!, '', undefined, '198.18.0.77')).status)
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true)
    expect(statuses[30]).toBe(429)
  })
})

/* ── Without an answer ────────────────────────────────────────────────────── */

describe('a request nobody answers', () => {
  it('is sent again after 48 hours, then applied in the first window still 24 hours away', async () => {
    const { app } = await setup()
    // Offered first (position 0) the later window, so the first eligible is not the earliest.
    const sent = await sentMaintenance(app.id, at(150), at(110))
    const [original] = tokensIn()
    const t0 = sent.sentAt

    expect(await runMaintenances(env, at(47, t0))).toMatchObject({ resent: 0, auto_applied: 0 })
    sentEmails().length = 0
    expect(await runMaintenances(env, at(49, t0))).toMatchObject({ resent: 1 })
    expect(await get(sent.id)).toMatchObject({ status: 'pending_approval', sends: 2 })
    expect(sentEmails().map((email) => email.subject)).toEqual(['Recordatorio: elige una ventana para “Actualización a la 1.1”'])
    const [second] = tokensIn()
    expect(second).not.toBe(original)
    expect(await publicJson(original!, '/approve', { window_id: sent.windows[0].id })).toMatchObject({ status: 410, body: { state: 'superseded' } })
    expect((await audit(sent.id, 'maintenance.resent'))?.actor_email).toBeNull()

    expect(await runMaintenances(env, at(96, t0))).toMatchObject({ auto_applied: 0 })
    sentEmails().length = 0
    expect(await runMaintenances(env, at(98, t0))).toMatchObject({ auto_applied: 1 })
    expect(await get(sent.id)).toMatchObject({ status: 'scheduled', auto_applied: true, chosen_window: { id: sent.windows[0].id } })
    expect(sentEmails().map((email) => email.subject)).toEqual(['Mantención agendada: “Actualización a la 1.1”'])
    const row = await audit(sent.id, 'maintenance.auto_applied')
    expect(row?.actor_email).toBeNull()
    expect(JSON.parse(row!.metadata)).toMatchObject({ automatic: true, cause: 'no_answer', sends: 2 })
    expect(await publicJson(second!, '/approve', { window_id: sent.windows[1].id })).toMatchObject({ status: 410, body: { state: 'closed' } })
  })

  it('ends as no_response when no window is 24 hours away any more, and tells the owner', async () => {
    const { app } = await setup()
    const sent = await sentMaintenance(app.id, at(115), at(118))
    await runMaintenances(env, at(49, sent.sentAt))
    expect(await runMaintenances(env, at(98, sent.sentAt))).toMatchObject({ no_response: 1 })
    expect(await get(sent.id)).toMatchObject({ status: 'no_response', chosen_window: null })
    expect(publishedNotifications().map((event) => event.type)).toEqual(['custom_apps.maintenance_no_response'])
    // Editable again, to be offered anew.
    expect((await panelJson(`/v1/maintenances/${sent.id}`, { method: 'PATCH', body: { title: 'Actualización, segunda vuelta' } })).status).toBe(200)
  })

  it('is applied as soon as its link expires, in a later window', async () => {
    const { app } = await setup()
    const sent = await sentMaintenance(app.id, at(30), at(80))
    expect(await runMaintenances(env, at(31, sent.sentAt))).toMatchObject({ auto_applied: 1, resent: 0 })
    expect(await get(sent.id)).toMatchObject({ status: 'scheduled', auto_applied: true, sends: 1, chosen_window: { id: sent.windows[1].id } })
    expect(JSON.parse((await audit(sent.id, 'maintenance.auto_applied'))!.metadata)).toMatchObject({ cause: 'link_expired' })
  })
})

/* ── Running it ───────────────────────────────────────────────────────────── */

/** An app with a release, two included devices and one left out, a contract, and a maintenance approved for a window three days out. */
const approvedWithRelease = async (options: { publish?: boolean; estimated?: number } = {}) => {
  const { app, company } = await setup({ contacts: [{ email: 'ops@cliente.cl', roles: ['maintenance_approver'] }] })
  const contract = await panelJson('/v1/contracts', { method: 'POST', body: { company_id: company.id, name: 'Mantención', starts_on: addDays(todayIn(), -5), included_minutes: 600, app_ids: [app.id] } })
  expect(contract.status).toBe(201)
  const upload = await withReleases(app.id)
  const release = await upload('1.1.0')
  if (options.publish) expect((await panelJson(`/v1/releases/${release.id}/publish`, { method: 'POST', body: { rollout_percent: 0 } })).status).toBe(200)
  const included = [await enrollDevice(app.id, app.key.key), await enrollDevice(app.id, app.key.key)]
  const outside = await enrollDevice(app.id, app.key.key)
  // The second device already had an override of its own, which the maintenance must give back.
  await panelJson(`/v1/installations/${included[1]!.installation_id}`, { method: 'PATCH', body: { state_override: 'active', state_message: 'Caja 2' } })
  const maintenance = await createMaintenance(app.id, { release_id: release.id, installation_ids: included.map((device) => device.installation_id), estimated_minutes: options.estimated ?? 60 })
  await addWindow(maintenance.id, at(72))
  await send(maintenance.id)
  const [token] = tokensIn()
  const window = (await get(maintenance.id)).windows[0]
  expect((await publicJson(token!, '/approve', { window_id: window.id })).status).toBe(200)
  sentEmails().length = 0
  publishedNotifications().length = 0
  return { app, contract: contract.body.data as Json, release, included, outside, maintenance, start: new Date(window.starts_at), end: new Date(window.ends_at) }
}

describe('a scheduled maintenance', () => {
  it('reminds the client 24 hours before, by email and in the app, once', async () => {
    const ctx = await approvedWithRelease()
    expect(await runMaintenances(env, at(-25, ctx.start.getTime()))).toMatchObject({ reminded: 0 })
    expect(await runMaintenances(env, at(-23, ctx.start.getTime()))).toMatchObject({ reminded: 1 })
    expect(sentEmails().map((email) => email.subject)).toEqual(['Recordatorio: mantención en 24 horas — “Actualización a la 1.1”'])
    const notices = await env.DB.prepare('SELECT scope, scope_value, severity, ends_at FROM messages WHERE created_by = ? ORDER BY scope_value').bind(`maintenance:${ctx.maintenance.id}`).all<Json>()
    // It names two installations, so one notice each.
    expect(notices.results).toEqual(ctx.included.map((device) => ({ scope: 'installation', scope_value: device.installation_id, severity: 'warning', ends_at: Math.floor(ctx.end.getTime() / 1000) })).sort((a, b) => a.scope_value.localeCompare(b.scope_value)))
    expect((await get(ctx.maintenance.id)).reminder_sent_at).not.toBeNull()
    expect(await runMaintenances(env, at(-22, ctx.start.getTime()))).toMatchObject({ reminded: 0 })
    expect(sentEmails()).toHaveLength(1)
  })

  it('starts in its window: the devices go into maintenance and are offered the release, and only they', async () => {
    const ctx = await approvedWithRelease()
    const started = new Date(ctx.start.getTime() + 60_000)
    expect(await runMaintenances(env, started)).toMatchObject({ started: 1 })
    const running = await get(ctx.maintenance.id)
    expect(running).toMatchObject({ status: 'in_progress', started_at: started.toISOString() })
    expect(running.result_detail).toMatchObject({
      installations: expect.arrayContaining(ctx.included.map((device) => device.installation_id)),
      targets: expect.arrayContaining(ctx.included.map((device) => device.installation_id)),
      already_on_version: [],
      release: { id: ctx.release.id, status_before: 'draft', published_by_maintenance: true },
    })
    const release = (await panelJson(`/v1/releases/${ctx.release.id}`)).body.data
    expect(release).toMatchObject({ status: 'published', rollout_percent: 0, published_by: `maintenance:${ctx.maintenance.id}` })
    expect(release.rollout_installations.sort()).toEqual(ctx.included.map((device) => device.installation_id).sort())

    // In maintenance, and still offered the update: that is when it is installed.
    const beat = (await ingestJson(ctx.app.id, '/heartbeat', { token: ctx.included[0]!.access_token, body: {} })).body.data
    expect(beat.state).toMatchObject({ state: 'maintenance', message: expect.stringContaining('Mantención en curso. Fin estimado:') })
    expect(beat.update).toMatchObject({ release_id: ctx.release.id, version: '1.1.0' })
    expect((await ingestJson(ctx.app.id, '/updates/latest', { token: ctx.included[1]!.access_token })).body.data).toMatchObject({ release_id: ctx.release.id })
    // The device left out is neither in maintenance nor offered it.
    expect((await ingestJson(ctx.app.id, '/heartbeat', { token: ctx.outside.access_token, body: {} })).body.data).toMatchObject({ state: { state: 'active' }, update: null })
    expect(await runMaintenances(env, new Date(started.getTime() + 60_000))).toMatchObject({ started: 0 })
    expect((await audit(ctx.maintenance.id, 'maintenance.started'))?.actor_email).toBeNull()
  })

  it('completes when every device came up healthy: overrides restored, hours logged, client told', async () => {
    const ctx = await approvedWithRelease()
    const started = new Date(ctx.start.getTime() + 60_000)
    await runMaintenances(env, started)
    for (const device of ctx.included) {
      await report(ctx.app.id, device.access_token, ctx.release.id, 'installed', new Date(started.getTime() + 60_000))
      await report(ctx.app.id, device.access_token, ctx.release.id, 'health_ok', new Date(started.getTime() + 120_000))
    }
    // Judged once the window and the health-check timeout (600 s by default) are over.
    expect(await runMaintenances(env, new Date(ctx.end.getTime() + 590_000))).toMatchObject({ completed: 0 })
    expect(await runMaintenances(env, new Date(ctx.end.getTime() + 610_000))).toMatchObject({ completed: 1 })

    const done = await get(ctx.maintenance.id)
    expect(done).toMatchObject({ status: 'completed', result: 'succeeded', closed_by: null, work_log_id: expect.any(String) })
    const [first, second] = await Promise.all(ctx.included.map(async (device) => (await panelJson(`/v1/installations/${device.installation_id}`)).body.data))
    expect(first).toMatchObject({ state_override: null, effective_state: 'active' })
    expect(second).toMatchObject({ state_override: 'active', state_message: 'Caja 2' })

    const logs = (await panelJson(`/v1/work-logs?maintenance_id=${ctx.maintenance.id}`)).body
    expect(logs.data).toEqual([
      expect.objectContaining({ id: done.work_log_id, app_id: ctx.app.id, kind: 'maintenance', minutes: 60, description: 'Actualización a la 1.1', maintenance_id: ctx.maintenance.id, maintenance_title: 'Actualización a la 1.1', contract_id: ctx.contract.id }),
    ])
    expect(sentEmails().map((email) => email.subject)).toEqual(['Mantención completada: “Actualización a la 1.1”'])
    expect(sentEmails()[0]!.text).toContain('versión 1.1.0')
    expect(publishedNotifications().map((event) => event.type)).toEqual(['custom_apps.maintenance_completed'])
    expect((await audit(ctx.maintenance.id, 'maintenance.completed'))?.actor_email).toBeNull()
    expect((await panelJson(`/v1/releases/${ctx.release.id}`)).body.data.status).toBe('published')
  })

  it('fails when a device rolled back or never reported: the release is withdrawn and everyone told', async () => {
    const ctx = await approvedWithRelease({ publish: true })
    const started = new Date(ctx.start.getTime() + 60_000)
    await runMaintenances(env, started)
    expect((await panelJson(`/v1/releases/${ctx.release.id}`)).body.data.rollout_installations.sort()).toEqual(ctx.included.map((device) => device.installation_id).sort())
    await report(ctx.app.id, ctx.included[0]!.access_token, ctx.release.id, 'rolled_back', new Date(started.getTime() + 60_000))
    expect(await runMaintenances(env, new Date(ctx.end.getTime() + 610_000))).toMatchObject({ failed: 1 })

    const failed = await get(ctx.maintenance.id)
    expect(failed).toMatchObject({ status: 'failed', result: 'failed', work_log_id: null })
    expect(failed.result_detail.failure).toEqual({
      reason: 'health_check',
      installations: expect.arrayContaining([
        { id: ctx.included[0]!.installation_id, status: 'rolled_back' },
        { id: ctx.included[1]!.installation_id, status: 'no_report' },
      ]),
    })
    const release = (await panelJson(`/v1/releases/${ctx.release.id}`)).body.data
    expect(release).toMatchObject({ status: 'withdrawn', status_reason: { automatic: true, reason: 'maintenance Actualización a la 1.1 failed health check' } })
    expect(publishedNotifications()).toEqual([expect.objectContaining({ type: 'custom_apps.maintenance_failed', data: expect.objectContaining({ reason: 'health_check: 2/2', failing: 2 }) })])
    expect(sentEmails().map((email) => email.subject)).toEqual(['La mantención no se pudo completar: “Actualización a la 1.1”'])
    expect(sentEmails()[0]!.text).toContain('volvieron a la versión que tenían antes')
    expect((await panelJson(`/v1/installations/${ctx.included[0]!.installation_id}`)).body.data.state_override).toBeNull()
    expect((await panelJson(`/v1/work-logs?maintenance_id=${ctx.maintenance.id}`)).body.data).toEqual([])
  })

  it('can be closed by hand while it runs, and cancelled only before', async () => {
    const ctx = await approvedWithRelease()
    expect((await panelJson(`/v1/maintenances/${ctx.maintenance.id}/complete`, { method: 'POST' })).status).toBe(409)
    await runMaintenances(env, new Date(ctx.start.getTime() + 60_000))
    expect((await panelJson(`/v1/maintenances/${ctx.maintenance.id}/cancel`, { method: 'POST' })).status).toBe(409)
    expect((await panelJson(`/v1/maintenances/${ctx.maintenance.id}/fail`, { method: 'POST', body: {} })).status).toBe(400)
    const failed = await panelJson(`/v1/maintenances/${ctx.maintenance.id}/fail`, { method: 'POST', body: { note: 'El lector de tarjetas dejó de responder' } })
    expect(failed.body.data).toMatchObject({ status: 'failed', closed_by: 'fran@franciscosolis.cl', result_detail: { note: 'El lector de tarjetas dejó de responder', failure: { reason: 'manual' } } })
    expect((await audit(ctx.maintenance.id, 'maintenance.failed'))?.actor_email).toBe('fran@franciscosolis.cl')
    expect(publishedNotifications()).toEqual([expect.objectContaining({ type: 'custom_apps.maintenance_failed', data: expect.objectContaining({ reason: 'El lector de tarjetas dejó de responder' }) })])
  })

  it('cancels before it starts: the links close and the in-app notice ends', async () => {
    const { app } = await setup()
    const sent = await sentMaintenance(app.id, at(72), at(96))
    const [token] = tokensIn()
    const cancelled = await panelJson(`/v1/maintenances/${sent.id}/cancel`, { method: 'POST', body: { reason: 'El cliente lo pidió por teléfono' } })
    expect(cancelled.body.data).toMatchObject({ status: 'cancelled', cancel_reason: 'El cliente lo pidió por teléfono', cancelled_by: 'fran@franciscosolis.cl' })
    expect(await publicJson(token!, '/approve', { window_id: sent.windows[0].id })).toMatchObject({ status: 410, body: { state: 'closed' } })
    expect((await publicJson(token!)).body.data.outcome).toMatchObject({ decision: 'cancelled' })
    expect((await panelJson(`/v1/maintenances/${sent.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await panelJson(`/v1/maintenances/${sent.id}`)).status).toBe(404)
  })
})

/* ── Security patches ─────────────────────────────────────────────────────── */

/** Usage for every hour of `hours` on the same Santiago weekday and hour of the last four weeks. */
const busy = async (appId: string, installationId: string, hours: number[]) => {
  const rows: Array<[number]> = []
  for (const hour of hours) {
    const target = zonedParts(new Date(hour * 1000))
    for (let week = 1; week <= 4; week += 1) {
      const guess = hour - week * 7 * 86_400
      // A daylight-saving change in between moves the same wall-clock hour by one.
      const past = [guess, guess - 3600, guess + 3600].find((candidate) => {
        const parts = zonedParts(new Date(candidate * 1000))
        return parts.weekday === target.weekday && parts.hour === target.hour
      })!
      rows.push([past])
    }
  }
  const statements = rows.map(([hourStart]) =>
    env.DB.prepare('INSERT OR IGNORE INTO usage_hourly (installation_id, app_id, hour_start, online_seconds, active_seconds, heartbeats) VALUES (?, ?, ?, 3600, 3600, 60)').bind(installationId, appId, hourStart),
  )
  for (let index = 0; index < statements.length; index += 50) await env.DB.batch(statements.slice(index, index + 50))
}

describe('a security patch', () => {
  it('needs no approval: it takes the first unused block within the contract’s days and tells the client', async () => {
    const { app, company } = await setup({ modules: ['updates'] })
    const contract = await panelJson('/v1/contracts', { method: 'POST', body: { company_id: company.id, name: 'Mantención', starts_on: addDays(todayIn(), -5), security_patch_days: 2, app_ids: [app.id] } })
    expect(contract.body.data.security_patch_days).toBe(2)
    expect((await panelJson(`/v1/contracts/${contract.body.data.id}`, { method: 'PATCH', body: { security_patch_days: 31 } })).status).toBe(400)
    const device = await enrollDevice(app.id, app.key.key)

    // Every hour of the next two days was busy in the past weeks, except one ten hours past the lead.
    const first = Math.ceil((Date.now() / 1000 + 2 * 3600) / 3600) * 3600
    const quiet = first + 10 * 3600
    await busy(app.id, device.installation_id, Array.from({ length: 48 }, (_, index) => first + index * 3600).filter((hour) => hour !== quiet))

    const maintenance = await createMaintenance(app.id, { kind: 'security', title: 'Parche OpenSSL', estimated_minutes: 30 })
    expect((await panelJson(`/v1/maintenances/${maintenance.id}/send`, { method: 'POST' })).status).toBe(409)
    const scheduled = await panelJson(`/v1/maintenances/${maintenance.id}/schedule`, { method: 'POST' })
    expect(scheduled.status).toBe(200)
    expect(scheduled.body.data).toMatchObject({ status: 'scheduled', kind: 'security', sends: 0, auto_applied: false, recipients: [] })
    expect(scheduled.body.data.windows).toEqual([expect.objectContaining({ source: 'suggested', chosen: true, starts_at: new Date(quiet * 1000).toISOString(), ends_at: new Date((quiet + 1800) * 1000).toISOString() })])
    expect(sentEmails().map((email) => email.subject)).toEqual(['Aviso de parche de seguridad: “Parche OpenSSL”'])
    expect(JSON.parse((await audit(maintenance.id, 'maintenance.scheduled'))!.metadata)).toMatchObject({ kind: 'security', security_patch_days: 2, expected_active_seconds: 0 })
    expect((await panelJson(`/v1/maintenances/${maintenance.id}/schedule`, { method: 'POST' })).status).toBe(409)
    expect((await panelJson(`/v1/maintenances/${maintenance.id}/send`, { method: 'POST' })).status).toBe(409)
  })

  it('falls back to the default three days without a contract, and refuses a normal maintenance', async () => {
    const { app } = await setup({ modules: ['updates'] })
    const normal = await createMaintenance(app.id)
    expect((await panelJson(`/v1/maintenances/${normal.id}/schedule`, { method: 'POST' })).status).toBe(409)
    const patch = await createMaintenance(app.id, { kind: 'security' })
    const scheduled = (await panelJson(`/v1/maintenances/${patch.id}/schedule`, { method: 'POST' })).body.data
    expect(Date.parse(scheduled.chosen_window.starts_at)).toBeGreaterThanOrEqual(Date.now() + 2 * HOUR - 60_000)
    expect(JSON.parse((await audit(patch.id, 'maintenance.scheduled'))!.metadata)).toMatchObject({ security_patch_days: 3 })
    // No messages module: the reminder posts nothing in the app.
    await runMaintenances(env, new Date(Date.parse(scheduled.chosen_window.starts_at) - 60_000))
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE created_by = ?').bind(`maintenance:${patch.id}`).first('n')).toBe(0)
  })
})

/* ── Grace ────────────────────────────────────────────────────────────────── */

describe('grace and suspension', () => {
  it('pause sending and scheduling unless the lapsed contract keeps maintenances running', async () => {
    const byHand = await setup()
    await panelJson(`/v1/apps/${byHand.app.id}/status`, { method: 'PUT', body: { state: 'grace', until: at(240).toISOString() } })
    const normal = await createMaintenance(byHand.app.id)
    await addWindow(normal.id, at(72))
    const refused = await panelJson(`/v1/maintenances/${normal.id}/send`, { method: 'POST' })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toContain('grace')
    const patch = await createMaintenance(byHand.app.id, { kind: 'security' })
    expect((await panelJson(`/v1/maintenances/${patch.id}/schedule`, { method: 'POST' })).status).toBe(409)

    const allowed = await setup()
    await panelJson('/v1/contracts', { method: 'POST', body: { company_id: allowed.company.id, name: 'Vencido', starts_on: addDays(todayIn(), -40), ends_on: addDays(todayIn(), -1), grace_days: 10, grace_allows: ['maintenance'], app_ids: [allowed.app.id] } })
    await runContracts(env, new Date())
    expect((await panelJson(`/v1/apps/${allowed.app.id}`)).body.data.state).toBe('grace')
    expect((await sentMaintenance(allowed.app.id, at(72), at(96))).status).toBe('pending_approval')
  })

  it('cancel a scheduled maintenance whose window comes while the app is suspended', async () => {
    const ctx = await approvedWithRelease()
    await panelJson(`/v1/apps/${ctx.app.id}/status`, { method: 'PUT', body: { state: 'suspended', message: 'Contrato vencido' } })
    expect(await runMaintenances(env, at(-23, ctx.start.getTime()))).toMatchObject({ reminded: 0 })
    expect(await runMaintenances(env, new Date(ctx.start.getTime() + 60_000))).toMatchObject({ started: 0, cancelled: 1 })
    expect(await get(ctx.maintenance.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'suspended', cancelled_by: null })
    expect((await panelJson(`/v1/installations/${ctx.included[0]!.installation_id}`)).body.data.state_override).toBeNull()
  })
})

/* ── Around it ────────────────────────────────────────────────────────────── */

describe('the panel around maintenances', () => {
  it('counts them on the overview, lists them by status and app, and documents every route', async () => {
    const { app } = await setup()
    const pending = await sentMaintenance(app.id, at(72), at(96))
    const scheduled = await sentMaintenance(app.id, at(100), at(130))
    const [, token] = tokensIn()
    expect((await publicJson(token!, '/approve', { window_id: scheduled.windows[0].id })).status).toBe(200)
    const rejected = await sentMaintenance(app.id, at(140), at(160))
    const rejectToken = tokensIn().at(-1)
    expect((await publicJson(rejectToken!, '/reject', { reason: 'No' })).status).toBe(200)

    const overview = (await panelJson('/v1/overview')).body.data
    expect(overview.maintenances).toEqual({ pending_approval: 1, upcoming: 1, in_progress: 0, needs_attention: 1 })

    expect((await panelJson('/v1/maintenances?status=pending')).body.data.map((row: Json) => row.id)).toEqual([pending.id])
    expect((await panelJson('/v1/maintenances?status=upcoming')).body.data.map((row: Json) => row.id)).toEqual([scheduled.id])
    expect((await panelJson(`/v1/apps/${app.id}/maintenances`)).body.pagination.total).toBe(3)
    const window = scheduled.windows[0]
    const calendar = await panelJson(`/v1/maintenances?from=${encodeURIComponent(window.starts_at)}&to=${encodeURIComponent(window.ends_at)}`)
    expect(calendar.body.data.map((row: Json) => row.id)).toEqual([scheduled.id])
    expect((await panelJson(`/v1/maintenances?company_id=${rejected.company_id}&status=draft`)).body.data).toEqual([expect.objectContaining({ id: rejected.id, rejected: true })])

    const root = (await panelJson('/')).body.data
    expect(root.maintenance_statuses).toEqual(['draft', 'pending_approval', 'scheduled', 'in_progress', 'completed', 'failed', 'no_response', 'cancelled'])
    expect(root.maintenance_kinds).toEqual(['normal', 'security'])
    expect(root.grace_allowances).toContain('maintenance')
    expect(root.contract_limits).toMatchObject({ default_security_patch_days: 3, max_security_patch_days: 30 })

    const spec = (await (await SELF.fetch('https://api.franciscosolis.cl/openapi.json')).json()) as Json
    for (const path of ['/v1/maintenances', '/v1/apps/{appId}/maintenances', '/v1/maintenances/{maintenanceId}/windows/suggest', '/v1/maintenances/{maintenanceId}/send', '/v1/public/maintenances/{token}', '/v1/public/maintenances/{token}/approve']) {
      expect(Object.keys(spec.paths)).toContain(path)
    }
    // The public routes need no token.
    expect(spec.paths['/v1/public/maintenances/{token}'].get.security).toBeUndefined()
  })

  it('links work log entries to a maintenance of the same company only', async () => {
    const { app, company } = await setup()
    const maintenance = await createMaintenance(app.id)
    const entry = await panelJson(`/v1/apps/${app.id}/work-logs`, { method: 'POST', body: { kind: 'maintenance', description: 'Preparación', occurred_on: todayIn(), minutes: 30, maintenance_id: maintenance.id } })
    expect(entry.status).toBe(201)
    expect(entry.body.data).toMatchObject({ maintenance_id: maintenance.id, maintenance_title: 'Actualización a la 1.1', company_id: company.id })
    const other = await setup()
    const foreign = await panelJson(`/v1/apps/${other.app.id}/work-logs`, { method: 'POST', body: { kind: 'maintenance', description: 'x', occurred_on: todayIn(), minutes: 30, maintenance_id: maintenance.id } })
    expect(foreign.status).toBe(422)
    // Deleting the maintenance keeps the entry, unlinked.
    expect((await panelJson(`/v1/maintenances/${maintenance.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await panelJson(`/v1/work-logs?company_id=${company.id}`)).body.data[0]).toMatchObject({ id: entry.body.data.id, maintenance_id: null })
  })
})
