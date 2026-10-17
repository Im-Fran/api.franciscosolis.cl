import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createApp, enrollDevice, ingestJson, panel, panelJson } from '../helpers/api'
import { batchOf, drainTelemetry, sentTelemetry } from '../helpers/telemetry'
import { consumeTelemetry } from '@/services/telemetry'

const fleet = async (modules = ['logs', 'crashes']) => {
  const created = await createApp({ modules })
  const device = await enrollDevice(created.id, created.key.key)
  return { app: created, device }
}

const entry = (level: string, message: string, overrides: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  level,
  message,
  occurred_at: new Date().toISOString(),
  ...overrides,
})

const RUST_PANIC = `thread 'main' panicked at src/printer.rs:42:17:
called \`Option::unwrap()\` on a \`None\` value
stack backtrace:
   0: 0x7ff6a1b2c3d4 - std::panicking::begin_panic_handler
   1: 0x7ff6a1b2c3e8 - core::panicking::panic
   2: 0x7ff6a1b2c400 - pos::printer::Printer::print_receipt
             at src/printer.rs:42:17
   3: 0x7ff6a1b2c4aa - pos::checkout::finish
             at src/checkout.rs:118:9`

const crash = (overrides: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  occurred_at: new Date().toISOString(),
  app_version: '1.4.0',
  kind: 'panic',
  message: 'called `Option::unwrap()` on a `None` value',
  stack: RUST_PANIC,
  ...overrides,
})

describe('remote logs', () => {
  it('drop what is below the level the device was told, per app and per device', async () => {
    const { app, device } = await fleet()
    const send = () =>
      ingestJson(app.id, '/logs', { token: device.access_token, body: { entries: [entry('debug', 'cache warm'), entry('info', 'sale started'), entry('error', 'printer offline', { target: 'printer', context: { port: 'COM3' } })] } })

    expect((await send()).body.data).toEqual({ accepted: 2, rejected: 0, dropped: 1 })
    await panel(`/v1/installations/${device.installation_id}`, { method: 'PATCH', body: { log_level_override: 'debug' } })
    expect((await ingestJson(app.id, '/heartbeat', { token: device.access_token, body: {} })).body.data.sync.log_level).toBe('debug')
    expect((await send()).body.data).toEqual({ accepted: 3, rejected: 0, dropped: 0 })
    await panel(`/v1/apps/${app.id}`, { method: 'PATCH', body: { log_level: 'error' } })
    await panel(`/v1/installations/${device.installation_id}`, { method: 'PATCH', body: { log_level_override: null } })
    expect((await send()).body.data).toEqual({ accepted: 1, rejected: 0, dropped: 2 })

    await drainTelemetry()
    const all = await panelJson(`/v1/installations/${device.installation_id}/logs`)
    expect(all.body.pagination.total).toBe(6)
    const errors = await panelJson(`/v1/apps/${app.id}/logs?level=warning`)
    expect(errors.body.data).toHaveLength(3)
    expect(errors.body.data[0]).toMatchObject({ level: 'error', message: 'printer offline', target: 'printer', context: { port: 'COM3' }, installation_id: device.installation_id })
    expect((await panelJson(`/v1/apps/${app.id}/logs?search=printer`)).body.pagination.total).toBe(3)
  })

  it('store a redelivered batch once', async () => {
    const { app, device } = await fleet()
    await ingestJson(app.id, '/logs', { token: device.access_token, body: { entries: [entry('warning', 'slow network')] } })
    const [message] = sentTelemetry()
    await consumeTelemetry(env, batchOf([message, message]))
    expect((await panelJson(`/v1/apps/${app.id}/logs`)).body.pagination.total).toBe(1)
  })

  it('are refused for an app without the module', async () => {
    const { app, device } = await fleet(['crashes'])
    expect((await ingestJson(app.id, '/logs', { token: device.access_token, body: { entries: [entry('error', 'x')] } })).status).toBe(403)
  })
})

describe('crashes', () => {
  it('group by stack, whatever the addresses and line numbers, and by version', async () => {
    const { app, device } = await fleet()
    const moved = RUST_PANIC.replace(/0x7ff6a1b2/g, '0x7ff7cccc').replace('42:17', '57:3').replace('118:9', '121:9')
    await ingestJson(app.id, '/crashes', { token: device.access_token, body: { crashes: [crash(), crash({ stack: moved }), crash({ app_version: '1.5.0' })] } })
    await ingestJson(app.id, '/crashes', { token: device.access_token, body: { crashes: [crash({ kind: 'SIGSEGV', stack: null, message: 'segfault at 0x10' })] } })
    await drainTelemetry()

    const groups = await panelJson(`/v1/apps/${app.id}/crashes`)
    expect(groups.body.pagination.total).toBe(3)
    const main = groups.body.data.find((group: { app_version: string; title: string }) => group.app_version === '1.4.0' && group.title.startsWith('panic'))
    expect(main).toMatchObject({ occurrences: 2, affected_installations: 1, status: 'open', title: 'panic: called `Option::unwrap()` on a `None` value' })

    const reports = await panelJson(`/v1/crashes/${main.id}/reports`)
    expect(reports.body.data).toHaveLength(2)
    expect(reports.body.data[0]).toMatchObject({ installation_id: device.installation_id, kind: 'panic', app_version: '1.4.0' })
    expect(reports.body.data[0].stack).toContain('print_receipt')
  })

  it('count a redelivered report once', async () => {
    const { app, device } = await fleet()
    await ingestJson(app.id, '/crashes', { token: device.access_token, body: { crashes: [crash()] } })
    const [message] = sentTelemetry()
    await consumeTelemetry(env, batchOf([message, message]))
    await consumeTelemetry(env, batchOf([message]))
    const [group] = (await panelJson(`/v1/apps/${app.id}/crashes`)).body.data
    expect(group.occurrences).toBe(1)
  })

  it('reopen a resolved group on a new report after the fix, never on an old one', async () => {
    const { app, device } = await fleet()
    await ingestJson(app.id, '/crashes', { token: device.access_token, body: { crashes: [crash()] } })
    await drainTelemetry()
    const [group] = (await panelJson(`/v1/apps/${app.id}/crashes`)).body.data
    const resolved = await panelJson(`/v1/crashes/${group.id}`, { method: 'PATCH', body: { status: 'resolved' } })
    expect(resolved.body.data).toMatchObject({ status: 'resolved', resolved_by: 'fran@franciscosolis.cl' })

    // A backlog flushed late: it happened before the fix.
    await ingestJson(app.id, '/crashes', { token: device.access_token, body: { crashes: [crash({ occurred_at: new Date(Date.now() - 3_600_000).toISOString() })] } })
    await drainTelemetry()
    expect((await panelJson(`/v1/crashes/${group.id}`)).body.data).toMatchObject({ status: 'resolved', occurrences: 2 })

    await env.DB.prepare('UPDATE crash_groups SET resolved_at = resolved_at - 10 WHERE id = ?').bind(group.id).run()
    await ingestJson(app.id, '/crashes', { token: device.access_token, body: { crashes: [crash()] } })
    await drainTelemetry()
    expect((await panelJson(`/v1/crashes/${group.id}`)).body.data).toMatchObject({ status: 'open', occurrences: 3, resolved_at: null })

    await panel(`/v1/crashes/${group.id}`, { method: 'PATCH', body: { status: 'ignored' } })
    await ingestJson(app.id, '/crashes', { token: device.access_token, body: { crashes: [crash()] } })
    await drainTelemetry()
    expect((await panelJson(`/v1/crashes/${group.id}`)).body.data).toMatchObject({ status: 'ignored', occurrences: 4 })
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE event = 'crash.status_changed' AND resource_id = ?").bind(app.id).first('n')).toBe(2)
  })

  it('are purged with the raw telemetry while their group keeps counting', async () => {
    const { app, device } = await fleet()
    await ingestJson(app.id, '/crashes', { token: device.access_token, body: { crashes: [crash()] } })
    await drainTelemetry()
    await env.DB.prepare('UPDATE crash_reports SET occurred_at = ?').bind(Date.now() - 31 * 86_400_000).run()
    const { runHourly } = await import('@/services/rollup')
    const result = await runHourly(env, new Date())
    expect(result.purged.crash_reports).toBe(1)
    const [group] = (await panelJson(`/v1/apps/${app.id}/crashes`)).body.data
    expect(group).toMatchObject({ occurrences: 1, affected_installations: 0 })
  })
})
