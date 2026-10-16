import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { evaluateAlerts } from '@/services/alerts'
import { runScheduled } from '@/services/maintenance'
import { createApp, enrollDevice, ingest, panel, panelJson } from '../helpers/api'
import { publishedNotifications } from '../helpers/notifications'

const minutesAgo = (minutes: number) => Math.floor(Date.now() / 1000) - minutes * 60

const setLastSeen = (installationId: string, secondsAgo: number) =>
  env.DB.prepare('UPDATE installations SET last_seen_at = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000) - secondsAgo, installationId).run()

const rule = async (body: Record<string, unknown>) => {
  const { status, body: answer } = await panelJson('/v1/alert-rules', { method: 'POST', body })
  if (status !== 201) throw new Error(`alert rule answered ${status}: ${JSON.stringify(answer)}`)
  return answer.data
}

describe('alert rules', () => {
  it('validate the threshold for their kind', async () => {
    expect((await panelJson('/v1/alert-rules', { method: 'POST', body: { name: 'CPU', kind: 'cpu_high', threshold: 120 } })).status).toBe(400)
    expect((await panelJson('/v1/alert-rules', { method: 'POST', body: { name: 'X', kind: 'disk_full', threshold: 1 } })).status).toBe(400)
    expect((await panelJson('/v1/alert-rules', { method: 'POST', body: { name: 'X', kind: 'crash_spike', threshold: 1, app_id: crypto.randomUUID() } })).status).toBe(422)
    const created = await rule({ name: 'Kiosk down', kind: 'installation_offline', threshold: 10 })
    expect(created).toMatchObject({ app_id: null, kind: 'installation_offline', threshold: 10, window_minutes: 15, enabled: true, notify_email: 'fran@franciscosolis.cl', open_alerts: 0 })
    expect((await panelJson(`/v1/alert-rules/${created.id}`, { method: 'PATCH', body: { threshold: 0 } })).status).toBe(400)
  })
})

describe('an offline installation', () => {
  it('opens one alert, notifies once, and resolves when the device is back', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    const offline = await rule({ name: 'Kiosk down', kind: 'installation_offline', threshold: 10, app_id: created.id })
    await setLastSeen(device.installation_id, 15 * 60)

    expect(await evaluateAlerts(env)).toMatchObject({ rules: 1, opened: 1 })
    const [alert] = (await panelJson('/v1/alerts?status=unresolved')).body.data
    expect(alert).toMatchObject({ rule_id: offline.id, installation_id: device.installation_id, status: 'open', value: 15, kind: 'installation_offline' })
    expect(publishedNotifications()).toEqual([
      expect.objectContaining({
        type: 'custom_apps.alert_opened',
        user: { id: 'admin-1', email: 'fran@franciscosolis.cl' },
        url: `/custom-apps/alerts/${alert.id}`,
        data: expect.objectContaining({ rule_name: 'Kiosk down', app_name: 'POS Andes', value: '15 min', threshold: '10 min' }),
      }),
    ])

    // Still offline: the same alert, no second notification.
    expect(await evaluateAlerts(env)).toMatchObject({ opened: 0, reopened: 0, resolved: 0 })
    expect(publishedNotifications()).toHaveLength(1)

    await ingest(created.id, '/heartbeat', { token: device.access_token, body: {} })
    expect(await evaluateAlerts(env)).toMatchObject({ resolved: 1 })
    expect((await panelJson(`/v1/alerts/${alert.id}`)).body.data).toMatchObject({ status: 'resolved', resolved_by: null })
    expect(publishedNotifications().map((event) => event.type)).toEqual(['custom_apps.alert_opened', 'custom_apps.alert_resolved'])

    // Down again within the window: reopened, counted, not announced again.
    await setLastSeen(device.installation_id, 20 * 60)
    expect(await evaluateAlerts(env)).toMatchObject({ reopened: 1, opened: 0 })
    expect((await panelJson(`/v1/alerts/${alert.id}`)).body.data).toMatchObject({ status: 'open', occurrences: 2 })
    expect(publishedNotifications()).toHaveLength(2)
  })

  it('leaves websites, revoked devices and suspended apps alone', async () => {
    const web = await createApp({ kind: 'web' })
    const browser = await enrollDevice(web.id, web.key.key, { platform: 'web' })
    const revoked = await enrollDevice(web.id, web.key.key)
    await panel(`/v1/installations/${revoked.installation_id}/revoke`, { method: 'POST' })
    await rule({ name: 'Down', kind: 'installation_offline', threshold: 5 })
    await setLastSeen(browser.installation_id, 3600)
    await setLastSeen(revoked.installation_id, 3600)
    expect(await evaluateAlerts(env)).toMatchObject({ opened: 0 })
  })

  it('goes quiet while its rule is silenced, but is still recorded', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    const offline = await rule({ name: 'Down', kind: 'installation_offline', threshold: 5 })
    await panel(`/v1/alert-rules/${offline.id}`, { method: 'PATCH', body: { silenced_until: new Date(Date.now() + 3_600_000).toISOString() } })
    await setLastSeen(device.installation_id, 600)
    expect(await evaluateAlerts(env)).toMatchObject({ opened: 1 })
    expect(publishedNotifications()).toEqual([])
    const [alert] = (await panelJson('/v1/alerts')).body.data
    expect(alert.notified_at).toBeNull()
  })

  it('can be acknowledged and resolved by hand', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    await rule({ name: 'Down', kind: 'installation_offline', threshold: 5 })
    await setLastSeen(device.installation_id, 600)
    await evaluateAlerts(env)
    const [alert] = (await panelJson('/v1/alerts')).body.data
    const acked = await panelJson(`/v1/alerts/${alert.id}/ack`, { method: 'POST' })
    expect(acked.body.data).toMatchObject({ status: 'acknowledged', acknowledged_by: 'fran@franciscosolis.cl' })
    // Acknowledged is still unresolved: evaluation keeps it, without reopening or notifying.
    expect(await evaluateAlerts(env)).toMatchObject({ opened: 0, resolved: 0 })
    expect((await panelJson('/v1/alerts?status=unresolved')).body.pagination.total).toBe(1)
    const resolved = await panelJson(`/v1/alerts/${alert.id}/resolve`, { method: 'POST', body: { note: 'Kiosk retired' } })
    expect(resolved.body.data).toMatchObject({ status: 'resolved', resolved_by: 'fran@franciscosolis.cl' })
    expect((await panelJson(`/v1/alerts/${alert.id}/ack`, { method: 'POST' })).status).toBe(409)
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE resource_id = ? AND event IN ('alert.acknowledged', 'alert.resolved')").bind(alert.id).first('n')).toBe(2)
  })
})

describe('the other kinds', () => {
  it('raise sustained CPU, but not a single hot sample', async () => {
    const created = await createApp()
    const hot = await enrollDevice(created.id, created.key.key)
    const blip = await enrollDevice(created.id, created.key.key)
    await rule({ name: 'Hot', kind: 'cpu_high', threshold: 90, window_minutes: 10 })
    const insert = (installationId: string, minutes: number, cpu: number) =>
      env.DB.prepare("INSERT INTO metric_samples (installation_id, app_id, source, recorded_at, received_at, cpu_percent) VALUES (?, ?, 'batch', ?, ?, ?)")
        .bind(installationId, created.id, Date.now() - minutes * 60_000, minutesAgo(minutes), cpu)
        .run()
    await insert(hot.installation_id, 8, 95)
    await insert(hot.installation_id, 4, 97)
    await insert(blip.installation_id, 8, 99)
    await insert(blip.installation_id, 4, 20)
    expect(await evaluateAlerts(env)).toMatchObject({ opened: 1 })
    const [alert] = (await panelJson('/v1/alerts')).body.data
    expect(alert).toMatchObject({ installation_id: hot.installation_id, value: 96 })
  })

  it('count crashes, error logs and enrollments per app in the window', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    await enrollDevice(created.id, created.key.key)
    await rule({ name: 'Crashes', kind: 'crash_spike', threshold: 2, window_minutes: 30 })
    await rule({ name: 'Errors', kind: 'error_log_spike', threshold: 2, window_minutes: 30 })
    await rule({ name: 'Enrollments', kind: 'enrollment_spike', threshold: 2, window_minutes: 30, app_id: created.id })
    for (const id of ['a', 'b']) {
      await env.DB.prepare("INSERT INTO crash_reports (installation_id, report_id, app_id, group_id, occurred_at, received_at) VALUES (?, ?, ?, 'g', ?, ?)")
        .bind(device.installation_id, id, created.id, Date.now() - 60_000, minutesAgo(1))
        .run()
      await env.DB.prepare("INSERT INTO log_entries (installation_id, entry_id, app_id, level, severity, message, occurred_at, received_at) VALUES (?, ?, ?, 'warning', 2, 'w', ?, ?)")
        .bind(device.installation_id, `w-${id}`, created.id, Date.now() - 60_000, minutesAgo(1))
        .run()
    }
    await env.DB.prepare("INSERT INTO log_entries (installation_id, entry_id, app_id, level, severity, message, occurred_at, received_at) VALUES (?, 'e', ?, 'error', 3, 'e', ?, ?)")
      .bind(device.installation_id, created.id, Date.now() - 60_000, minutesAgo(1))
      .run()
    const result = await evaluateAlerts(env)
    // Crashes (2) and enrollments (2) trip; one error and two warnings do not make two errors.
    expect(result).toMatchObject({ opened: 2 })
    const kinds = (await panelJson('/v1/alerts')).body.data.map((alert: { kind: string; subject: string }) => [alert.kind, alert.subject]).sort()
    expect(kinds).toEqual([
      ['crash_spike', `app:${created.id}`],
      ['enrollment_spike', `app:${created.id}`],
    ])
  })
})

describe('the five-minute cron', () => {
  it('suspends an app whose grace period ran out, with no actor in the audit trail', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    await panel(`/v1/apps/${created.id}/status`, { method: 'PUT', body: { state: 'grace', message: 'Renueve su contrato', until: new Date(Date.now() + 86_400_000).toISOString() } })
    await env.DB.prepare('UPDATE apps SET state_until = ? WHERE id = ?').bind(minutesAgo(1), created.id).run()

    const result = await runScheduled(env, new Date())
    expect(result.suspended_apps).toBe(1)
    const status = (await (await ingest(created.id, '/status', { token: device.access_token })).json()) as { data: Record<string, unknown> }
    expect(status.data).toMatchObject({ state: 'suspended', message: 'Renueve su contrato', until: null })
    const audit = await env.DB.prepare("SELECT actor_email, metadata FROM audit_logs WHERE resource_id = ? AND event = 'app.state_changed' ORDER BY rowid DESC").bind(created.id).first<{ actor_email: string | null; metadata: string }>()
    expect(audit!.actor_email).toBeNull()
    expect(JSON.parse(audit!.metadata)).toMatchObject({ automatic: true, reason: 'grace_period_ended', after: { state: 'suspended' } })
  })

  it('refuses a grace period with no end, or longer than a month', async () => {
    const created = await createApp()
    const put = (until?: string) => panelJson(`/v1/apps/${created.id}/status`, { method: 'PUT', body: { state: 'grace', until } })
    expect((await put()).status).toBe(400)
    expect((await put(new Date(Date.now() - 1000).toISOString())).status).toBe(400)
    expect((await put(new Date(Date.now() + 40 * 86_400_000).toISOString())).status).toBe(400)
  })

  it('runs the hourly work only on the first run of the hour', async () => {
    expect((await runScheduled(env, new Date('2026-10-15T15:00:00Z'))).hourly).not.toBeNull()
    expect((await runScheduled(env, new Date('2026-10-15T15:05:00Z'))).hourly).toBeNull()
  })

  it('shows the unresolved alerts on the overview', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    await rule({ name: 'Down', kind: 'installation_offline', threshold: 5 })
    await setLastSeen(device.installation_id, 600)
    await runScheduled(env, new Date())
    expect((await panelJson('/v1/overview')).body.data.alerts).toEqual({ unresolved: 1 })
  })
})
