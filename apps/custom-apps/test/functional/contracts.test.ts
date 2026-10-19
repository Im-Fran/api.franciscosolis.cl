import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { addDays } from '@/lib/hours'
import { startOfZonedDay } from '@/lib/time'
import { evaluateAlerts } from '@/services/alerts'
import { runContracts, todayIn } from '@/services/contracts'
import { runScheduled } from '@/services/maintenance'
import { createApp, createCompany, enrollDevice, ingest, ingestJson, panel, panelJson, type Json } from '../helpers/api'
import { failEmail, sentEmails } from '../helpers/email'

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

let rutSeed = 60_000_000
const company = (overrides: Json = {}) => createCompany({ legal_name: `Cliente ${rutSeed} SpA`, rut: rut(rutSeed++), ...overrides })

const today = () => todayIn()

const setup = async (contract: Json = {}, appOverrides: Json = {}) => {
  const owner = await company()
  const created = await createApp({ company_id: owner.id, modules: ['messages', 'logs', 'crashes', 'support', 'updates'], ...appOverrides })
  const response = await panelJson('/v1/contracts', {
    method: 'POST',
    body: { company_id: owner.id, name: 'Mantención mensual', amount: 3.5, currency: 'UF', starts_on: addDays(today(), -5), included_minutes: 600, overage_rate: 1, app_ids: [created.id], ...contract },
  })
  if (response.status !== 201) throw new Error(`contract answered ${response.status}: ${JSON.stringify(response.body)}`)
  return { company: owner, app: created, contract: response.body.data as Json }
}

const log = (appId: string, body: Json) => panelJson(`/v1/apps/${appId}/work-logs`, { method: 'POST', body: { kind: 'maintenance', description: 'Actualización de drivers', occurred_on: today(), minutes: 60, ...body } })

const addBillingContact = async (companyId: string, email: string) => {
  const contact = (await panelJson('/v1/contacts', { method: 'POST', body: { name: 'Pagos', emails: [email] } })).body.data
  await panel(`/v1/companies/${companyId}/contacts/${contact.id}`, { method: 'PUT', body: { roles: ['billing'] } })
}

describe('contracts', () => {
  it('cover a company’s apps, one contract per app at a time, and open their first cycle', async () => {
    const { company: owner, app, contract } = await setup()
    expect(contract).toMatchObject({
      company_id: owner.id,
      name: 'Mantención mensual',
      currency: 'UF',
      status: 'active',
      expiring: false,
      apps: [{ id: app.id, name: app.name }],
      current_cycle: { status: 'open', included_minutes: 600, carried_minutes: 0, used_minutes: 0, remaining_minutes: 600 },
    })
    expect(contract.current_cycle.starts_on).toBe(addDays(today(), -5))

    const clash = await panelJson('/v1/contracts', { method: 'POST', body: { company_id: owner.id, name: 'Otro', starts_on: today(), app_ids: [app.id] } })
    expect(clash.status).toBe(409)
    // After the first one ends, the app can be covered again.
    await panelJson(`/v1/contracts/${contract.id}`, { method: 'PATCH', body: { ends_on: addDays(today(), 10) } })
    expect((await panelJson('/v1/contracts', { method: 'POST', body: { company_id: owner.id, name: 'Siguiente', starts_on: addDays(today(), 11), app_ids: [app.id] } })).status).toBe(201)

    const foreign = await createApp({ company_id: (await company()).id })
    expect((await panelJson('/v1/contracts', { method: 'POST', body: { company_id: owner.id, name: 'X', starts_on: today(), app_ids: [foreign.id] } })).status).toBe(422)
    expect((await panelJson('/v1/contracts', { method: 'POST', body: { company_id: owner.id, name: 'X', starts_on: '2026-02-30' } })).status).toBe(400)
    expect((await panelJson('/v1/contracts', { method: 'POST', body: { company_id: owner.id, name: 'X', starts_on: today(), ends_on: addDays(today(), -1) } })).status).toBe(400)

    const listed = await panelJson(`/v1/contracts?company_id=${owner.id}&status=active`)
    expect(listed.body.pagination.total).toBe(1)
    expect((await panelJson(`/v1/contracts?app_id=${app.id}`)).body.pagination.total).toBe(2)
  })

  it('fix their anchor once a cycle exists', async () => {
    const { contract } = await setup()
    expect((await panelJson(`/v1/contracts/${contract.id}`, { method: 'PATCH', body: { cycle_period: 'weekly' } })).status).toBe(409)
    expect((await panelJson(`/v1/contracts/${contract.id}`, { method: 'PATCH', body: { starts_on: addDays(today(), -3) } })).status).toBe(409)
    const edited = await panelJson(`/v1/contracts/${contract.id}`, { method: 'PATCH', body: { included_minutes: 900, grace_allows: ['support', 'updates', 'support'] } })
    expect(edited.body.data).toMatchObject({ included_minutes: 900, grace_allows: ['support', 'updates'] })
  })
})

describe('the work log', () => {
  it('files entries under the contract and cycle of their day, and adds them up', async () => {
    const { app, contract } = await setup()
    const first = await log(app.id, { minutes: 90, link_url: 'https://github.com/x/y/pull/1' })
    expect(first.status).toBe(201)
    expect(first.body.data).toMatchObject({ app_id: app.id, contract_id: contract.id, cycle_id: contract.current_cycle.id, minutes: 90, editable: true })
    await log(app.id, { minutes: 30, kind: 'support' })
    // Company-wide work, no app: still the one contract of the company.
    await panelJson('/v1/work-logs', { method: 'POST', body: { company_id: contract.company_id, kind: 'other', description: 'Reunión', occurred_on: today(), minutes: 45 } })

    const detail = (await panelJson(`/v1/contracts/${contract.id}`)).body.data
    expect(detail.current_cycle).toMatchObject({ used_minutes: 165, remaining_minutes: 435, overage_minutes: 0 })
    expect(detail.current_cycle_usage_by_app).toEqual(expect.arrayContaining([{ app_id: app.id, app_name: app.name, minutes: 120 }, { app_id: null, app_name: null, minutes: 45 }]))

    const listed = await panelJson(`/v1/apps/${app.id}/work-logs?kind=maintenance`)
    expect(listed.body.totals.minutes).toBe(90)
    expect(listed.body.pagination.total).toBe(1)
    expect((await panelJson(`/v1/work-logs?contract_id=${contract.id}`)).body.totals.minutes).toBe(165)

    const edited = await panelJson(`/v1/work-logs/${first.body.data.id}`, { method: 'PATCH', body: { minutes: 120 } })
    expect(edited.body.data.minutes).toBe(120)
    expect((await panelJson(`/v1/work-logs/${first.body.data.id}`, { method: 'DELETE' })).status).toBe(200)
  })

  it('refuses the future, a closed cycle, and an ambiguous contract', async () => {
    const { app, company: owner, contract } = await setup({ starts_on: addDays(today(), -40) })
    expect((await log(app.id, { occurred_on: addDays(today(), 1) })).status).toBe(400)
    // The first month already closed when the contract was read.
    expect((await log(app.id, { occurred_on: addDays(today(), -39) })).status).toBe(409)
    const cycles = (await panelJson(`/v1/contracts/${contract.id}/cycles`)).body.data
    expect(cycles.map((cycle: Json) => cycle.status)).toEqual(['open', 'closed'])

    // A second contract for the same company with no apps: company-wide work is now ambiguous.
    await panelJson('/v1/contracts', { method: 'POST', body: { company_id: owner.id, name: 'Soporte', starts_on: addDays(today(), -1) } })
    const ambiguous = await panelJson('/v1/work-logs', { method: 'POST', body: { company_id: owner.id, kind: 'support', description: 'x', occurred_on: today(), minutes: 10 } })
    expect(ambiguous.status).toBe(422)
    // Work outside any contract is still kept.
    const other = await createApp({ company_id: owner.id })
    const uncovered = await log(other.id, {})
    expect(uncovered.body.data).toMatchObject({ contract_id: null, cycle_id: null })
  })
})

describe('cycles', () => {
  it('close on their own, carry what the policy allows, and price the overage', async () => {
    const { app, contract } = await setup({ starts_on: addDays(today(), -40), included_minutes: 600, rollover_enabled: true, rollover_max_cycles: 2, overage_rate: 2, currency: 'UF' })
    let cycles = (await panelJson(`/v1/contracts/${contract.id}/cycles`)).body.data
    // The first month was unused and rolled over in full.
    expect(cycles[0]).toMatchObject({ status: 'open', carried_minutes: 600, available_minutes: 1200 })
    expect(cycles[1]).toMatchObject({ status: 'closed', used_minutes: 0, overage_minutes: 0, expired_minutes: 0 })
    await log(app.id, { minutes: 1350 })

    // Two months later, from the cron's point of view.
    const later = startOfZonedDay(addDays(today(), 62))
    await runContracts(env, later)
    cycles = (await panelJson(`/v1/contracts/${contract.id}/cycles`)).body.data
    const closed = cycles.find((cycle: Json) => cycle.id === contract.current_cycle.id)
    expect(closed).toMatchObject({ status: 'closed', used_minutes: 1350, overage_minutes: 150, overage_amount: 5, closed_by: null })

    const billed = await panelJson(`/v1/cycles/${closed.id}/bill`, { method: 'POST', body: { reference: 'Factura 1234' } })
    expect(billed.body.data).toMatchObject({ status: 'billed', billing_reference: 'Factura 1234', billed_by: 'fran@franciscosolis.cl' })
    expect((await panelJson(`/v1/cycles/${closed.id}/bill`, { method: 'POST' })).status).toBe(409)
    const shown = (await panelJson(`/v1/cycles/${closed.id}`)).body.data
    expect(shown.work_logs).toHaveLength(1)
    expect(shown.work_logs[0].editable).toBe(false)
    expect((await panelJson(`/v1/work-logs/${shown.work_logs[0].id}`, { method: 'DELETE' })).status).toBe(409)

    const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE event = 'cycle.closed' AND resource_id = ?").bind(contract.id).first<{ n: number }>()
    expect(audit!.n).toBeGreaterThanOrEqual(2)
  })

  it('open a short, prorated cycle after a renewal of a contract that ended mid-cycle', async () => {
    // Weekly from 60 days ago, ended yesterday: the ninth cycle (days 56–62) was cut at the end, today.
    const { app, contract } = await setup({ cycle_period: 'weekly', starts_on: addDays(today(), -60), ends_on: addDays(today(), -1), included_minutes: 700, grace_days: 5 })
    await runScheduled(env, new Date())
    let cycles = (await panelJson(`/v1/contracts/${contract.id}/cycles`)).body.data
    expect(cycles).toHaveLength(9)
    expect(cycles.every((cycle: Json) => cycle.status === 'closed')).toBe(true)
    expect(cycles[0]).toMatchObject({ starts_on: addDays(today(), -4), ends_on: today() })
    expect((await panelJson(`/v1/contracts/${contract.id}`)).body.data).toMatchObject({ status: 'grace', current_cycle: null })

    // Renewing used to send the cycle sync round in circles: the next cycle mapped back onto the
    // closed one it was meant to follow, until the step limit, on every read.
    expect((await panelJson(`/v1/contracts/${contract.id}/renew`, { method: 'POST', body: { ends_on: addDays(today(), 60) } })).status).toBe(200)
    const started = Date.now()
    const shown = await panelJson(`/v1/contracts/${contract.id}`)
    const listed = await panelJson(`/v1/contracts?company_id=${contract.company_id}`)
    const listedCycles = await panelJson(`/v1/contracts/${contract.id}/cycles`)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect([shown.status, listed.status, listedCycles.status]).toEqual([200, 200, 200])

    // From the old end + 1 (today) to the next anchored boundary (day 63), 3 of 7 days' minutes.
    const short = { status: 'open', starts_on: today(), ends_on: addDays(today(), 3), included_minutes: 300 }
    expect(shown.body.data).toMatchObject({ status: 'active', current_cycle: short })
    expect(listed.body.data).toEqual([expect.objectContaining({ id: contract.id, current_cycle: expect.objectContaining(short) })])
    expect(listedCycles.body.data).toHaveLength(10)
    expect(listedCycles.body.data[0]).toMatchObject(short)

    // Work done today is filed into the short cycle; yesterday is still the closed one.
    const logged = await log(app.id, { minutes: 30 })
    expect(logged.body.data).toMatchObject({ contract_id: contract.id, cycle_id: shown.body.data.current_cycle.id })
    expect((await log(app.id, { occurred_on: addDays(today(), -1) })).status).toBe(409)

    // The cycles after it are whole weeks again, with every included minute.
    await runContracts(env, startOfZonedDay(addDays(today(), 4)))
    cycles = (await panelJson(`/v1/contracts/${contract.id}/cycles`)).body.data
    expect(cycles).toHaveLength(11)
    expect(cycles[0]).toMatchObject({ status: 'open', starts_on: addDays(today(), 3), ends_on: addDays(today(), 10), included_minutes: 700 })
    expect(cycles[1]).toMatchObject({ status: 'closed', starts_on: today(), used_minutes: 30 })
    // Nothing else was opened along the way.
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM contract_cycles WHERE contract_id = ?').bind(contract.id).first<{ n: number }>()
    expect(count!.n).toBe(11)
  })

  it('stretch a cycle still open when the contract is renewed before its end', async () => {
    // Weekly from 60 days ago, ending tomorrow: the open cycle (days 56–62) is cut after tomorrow.
    const { contract } = await setup({ cycle_period: 'weekly', starts_on: addDays(today(), -60), ends_on: addDays(today(), 1), included_minutes: 700 })
    const before = (await panelJson(`/v1/contracts/${contract.id}`)).body.data.current_cycle
    expect(before).toMatchObject({ starts_on: addDays(today(), -4), ends_on: addDays(today(), 2), included_minutes: 700 })

    expect((await panelJson(`/v1/contracts/${contract.id}/renew`, { method: 'POST', body: { ends_on: addDays(today(), 60) } })).status).toBe(200)
    // The same cycle now runs to its anchored boundary: no short cycle after it, no minutes twice.
    const after = (await panelJson(`/v1/contracts/${contract.id}`)).body.data.current_cycle
    expect(after).toMatchObject({ id: before.id, starts_on: addDays(today(), -4), ends_on: addDays(today(), 3), included_minutes: 700 })
    await runContracts(env, startOfZonedDay(addDays(today(), 3)))
    const cycles = (await panelJson(`/v1/contracts/${contract.id}/cycles`)).body.data
    expect(cycles[0]).toMatchObject({ status: 'open', starts_on: addDays(today(), 3), ends_on: addDays(today(), 10), included_minutes: 700 })
    expect(cycles[1]).toMatchObject({ id: before.id, status: 'closed', ends_on: addDays(today(), 3) })
  })

  it('never answer a negative remainder: what is over budget is overage', async () => {
    const { app, contract } = await setup({ included_minutes: 30 })
    await log(app.id, { minutes: 75 })
    const cycle = (await panelJson(`/v1/contracts/${contract.id}`)).body.data.current_cycle
    expect(cycle).toMatchObject({ available_minutes: 30, used_minutes: 75, remaining_minutes: 0, overage_minutes: 45 })
  })

  it('cannot be closed by hand while still running', async () => {
    const { contract } = await setup()
    expect((await panelJson(`/v1/cycles/${contract.current_cycle.id}/close`, { method: 'POST' })).status).toBe(409)
  })
})

describe('the end of a contract', () => {
  it('warns the client once, by email and in the app', async () => {
    const { company: owner, app, contract } = await setup({ ends_on: addDays(today(), 10), notice_days: 30, grace_days: 7 })
    await addBillingContact(owner.id, 'pagos@cliente.cl')
    const device = await enrollDevice(app.id, app.key.key)

    expect((await runContracts(env, new Date())).notices).toBe(1)
    expect(sentEmails()).toHaveLength(1)
    expect(sentEmails()[0]).toMatchObject({ to: ['pagos@cliente.cl'], from: { email: 'hola@mail.franciscosolis.cl' } })
    expect(sentEmails()[0]!.subject).toContain('Mantención mensual')
    expect(sentEmails()[0]!.text).toContain('7 días')
    const messages = (await ingestJson(app.id, '/messages', { token: device.access_token })).body.data
    expect(messages).toEqual([expect.objectContaining({ severity: 'warning', title: 'El contrato de servicio está por terminar' })])
    expect((await panelJson(`/v1/contracts/${contract.id}`)).body.data).toMatchObject({ expiring: true, days_left: 10 })
    expect((await panelJson(`/v1/contracts/${contract.id}`)).body.data.notice_sent_at).not.toBeNull()

    await runContracts(env, new Date())
    expect(sentEmails()).toHaveLength(1)
  })

  it('retries the notice when the email fails', async () => {
    const { company: owner } = await setup({ ends_on: addDays(today(), 3) })
    await addBillingContact(owner.id, 'pagos@cliente.cl')
    failEmail()
    expect(await runContracts(env, new Date())).toMatchObject({ notices: 0, failed: 1 })
    failEmail(false)
    expect((await runContracts(env, new Date())).notices).toBe(1)
  })

  it('puts the apps in grace when it lapses, and a renewal brings them back', async () => {
    const { app, contract } = await setup({ ends_on: addDays(today(), -1), grace_days: 5, grace_message: 'Renueve su contrato' })
    const device = await enrollDevice(app.id, app.key.key)
    await runScheduled(env, new Date())
    const lapsed = (await panelJson(`/v1/apps/${app.id}`)).body.data
    expect(lapsed).toMatchObject({ state: 'grace', state_message: 'Renueve su contrato' })
    expect(lapsed.state_until).toBe(startOfZonedDay(addDays(today(), 5)).toISOString())
    expect((await ingestJson(app.id, '/status', { token: device.access_token })).body.data).toMatchObject({ state: 'grace' })
    expect((await panelJson(`/v1/contracts/${contract.id}`)).body.data).toMatchObject({ status: 'grace' })
    const audit = await env.DB.prepare("SELECT metadata FROM audit_logs WHERE event = 'app.state_changed' AND resource_id = ? ORDER BY created_at DESC LIMIT 1").bind(app.id).first<{ metadata: string }>()
    expect(JSON.parse(audit!.metadata)).toMatchObject({ automatic: true, reason: 'contract_lapsed', contract_id: contract.id })

    // Support is paused in grace unless the contract keeps it running.
    expect((await ingest(app.id, '/tickets', { token: device.access_token, body: { subject: 'x', message: 'y' } })).status).toBe(403)
    await panelJson(`/v1/contracts/${contract.id}`, { method: 'PATCH', body: { grace_allows: ['support'] } })
    expect((await ingest(app.id, '/tickets', { token: device.access_token, body: { subject: 'x', message: 'y' } })).status).toBe(201)

    const renewed = await panelJson(`/v1/contracts/${contract.id}/renew`, { method: 'POST', body: { ends_on: addDays(today(), 365) } })
    expect(renewed.body.data).toMatchObject({ status: 'active', lapsed_at: null })
    expect((await panelJson(`/v1/apps/${app.id}`)).body.data).toMatchObject({ state: 'active', state_message: null, state_until: null })
    expect((await panelJson(`/v1/contracts/${contract.id}/renew`, { method: 'POST', body: { ends_on: addDays(today(), 30) } })).status).toBe(409)
  })

  it('suspends at once with no grace days, and leaves alone a contract that renews itself', async () => {
    const strict = await setup({ ends_on: addDays(today(), -1), grace_days: 0 })
    const renewing = await setup({ ends_on: addDays(today(), -1), auto_renew: true, renewal_months: 12 })
    const result = await runContracts(env, new Date())
    expect(result).toMatchObject({ lapsed: 1, renewed: 1 })
    expect((await panelJson(`/v1/apps/${strict.app.id}`)).body.data.state).toBe('suspended')
    expect((await panelJson(`/v1/apps/${renewing.app.id}`)).body.data.state).toBe('active')
    const extended = (await panelJson(`/v1/contracts/${renewing.contract.id}`)).body.data
    expect(extended.ends_on > today()).toBe(true)
    expect(extended.status).toBe('active')
  })

  it('can be cancelled, and deleted only without history', async () => {
    const { app, contract } = await setup()
    await log(app.id, {})
    expect((await panelJson(`/v1/contracts/${contract.id}`, { method: 'DELETE' })).status).toBe(409)
    const cancelled = await panelJson(`/v1/contracts/${contract.id}/cancel`, { method: 'POST', body: { reason: 'Cliente cerró' } })
    expect(cancelled.body.data).toMatchObject({ status: 'cancelled', cancelled_by: 'fran@franciscosolis.cl', cancel_reason: 'Cliente cerró' })
    expect((await panelJson(`/v1/contracts/${contract.id}`)).body.data.cancel_reason).toBe('Cliente cerró')
    const audit = await env.DB.prepare("SELECT metadata FROM audit_logs WHERE event = 'contract.cancelled' AND resource_id = ?").bind(contract.id).first<{ metadata: string }>()
    expect(JSON.parse(audit!.metadata)).toMatchObject({ reason: 'Cliente cerró' })
    expect((await panelJson(`/v1/contracts/${contract.id}`, { method: 'PATCH', body: { name: 'x' } })).status).toBe(409)

    // No reason is a null one.
    const quiet = await setup()
    expect((await panelJson(`/v1/contracts/${quiet.contract.id}/cancel`, { method: 'POST' })).body.data).toMatchObject({ status: 'cancelled', cancel_reason: null })

    const empty = await setup({ starts_on: addDays(today(), 3) })
    expect((await panelJson(`/v1/contracts/${empty.contract.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await panel(`/v1/companies/${contract.company_id}`, { method: 'DELETE' })).status).toBe(409)
  })
})

describe('contract alerts', () => {
  it('open for a contract ending soon and a cycle running out of hours', async () => {
    const { app } = await setup({ ends_on: addDays(today(), 12), included_minutes: 100 })
    await panelJson('/v1/alert-rules', { method: 'POST', body: { name: 'Contratos', kind: 'contract_expiring', threshold: 15 } })
    await panelJson('/v1/alert-rules', { method: 'POST', body: { name: 'Horas', kind: 'cycle_hours_low', threshold: 25, app_id: app.id } })
    await log(app.id, { minutes: 80 })
    expect(await evaluateAlerts(env)).toMatchObject({ opened: 2 })
    const alerts = (await panelJson('/v1/alerts?status=unresolved')).body.data
    expect(alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'contract_expiring', value: 12, app_id: app.id, subject_name: 'Mantención mensual' }),
        expect.objectContaining({ kind: 'cycle_hours_low', value: 20, app_id: app.id }),
      ]),
    )
  })
})

describe('the overview', () => {
  it('counts contracts ending or in grace and cycles over budget', async () => {
    const { app } = await setup({ ends_on: addDays(today(), 5), included_minutes: 30 })
    await setup({ ends_on: addDays(today(), -2), grace_days: 10 })
    await log(app.id, { minutes: 60 })
    const overview = (await panelJson('/v1/overview')).body.data
    expect(overview.contracts).toMatchObject({ active: 1, expiring: 1, in_grace: 1 })
    expect(overview.cycles).toMatchObject({ exceeded: 1 })
  })
})
