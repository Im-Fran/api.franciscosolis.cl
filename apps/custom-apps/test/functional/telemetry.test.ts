import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { batchOf, drainTelemetry, sentTelemetry } from '../helpers/telemetry'
import { createApp, enrollDevice, ingest, ingestJson, panelJson } from '../helpers/api'
import worker from '@/index'
import { consumeTelemetry } from '@/services/telemetry'
import { runHourly } from '@/services/rollup'

afterEach(() => {
  vi.useRealTimers()
})

const setLastSeen = (installationId: string, secondsAgo: number) =>
  env.DB.prepare('UPDATE installations SET last_seen_at = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000) - secondsAgo, installationId).run()

describe('heartbeats', () => {
  it('keep an installation connected and answer with its state and presence settings', async () => {
    const created = await createApp({ heartbeat_interval_seconds: 30 })
    const device = await enrollDevice(created.id, created.key.key)
    const { status, body } = await ingestJson(created.id, '/heartbeat', { token: device.access_token, body: { active_seconds: 10 } })
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ state: { state: 'active' }, presence: { mode: 'ping', interval_seconds: 30 } })
    expect(Date.parse(body.data.server_time)).toBeGreaterThan(Date.now() - 5000)

    expect((await panelJson(`/v1/installations/${device.installation_id}`)).body.data.connected).toBe(true)
    await setLastSeen(device.installation_id, 91)
    expect((await panelJson(`/v1/installations/${device.installation_id}`)).body.data.connected).toBe(false)
  })

  it('credit the time since the previous one to the hour, as online and as in use', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    await setLastSeen(device.installation_id, 60)
    await ingest(created.id, '/heartbeat', { token: device.access_token, body: { active_seconds: 40 } })

    const rows = (await env.DB.prepare('SELECT online_seconds, active_seconds, heartbeats FROM usage_hourly WHERE installation_id = ?').bind(device.installation_id).all<Record<string, number>>()).results
    const totals = rows.reduce((sum, row) => ({ online: sum.online + row.online_seconds!, active: sum.active + row.active_seconds!, beats: sum.beats + row.heartbeats! }), { online: 0, active: 0, beats: 0 })
    expect(totals.online).toBeGreaterThanOrEqual(60)
    expect(totals.online).toBeLessThanOrEqual(62)
    expect(totals.active).toBe(40)
    expect(totals.beats).toBe(1)
  })

  it('keep the snapshot as the live view, and as the sample of its minute when metrics are on', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    const snapshot = { cpu_percent: 37.5, memory_used_bytes: 4_000_000_000, memory_total_bytes: 8_000_000_000, battery_percent: null, uptime_seconds: 3600 }
    await ingest(created.id, '/heartbeat', { token: device.access_token, body: { snapshot } })

    const detail = (await panelJson(`/v1/installations/${device.installation_id}`)).body.data
    expect(detail.last_snapshot).toMatchObject(snapshot)
    // Written with the heartbeat itself, not through the queue: "last of the minute" needs arrival order.
    expect(sentTelemetry()).toEqual([])
    const sample = await env.DB.prepare('SELECT source, recorded_at, cpu_percent FROM metric_samples WHERE installation_id = ?').bind(device.installation_id).first<Record<string, unknown>>()
    expect(sample).toMatchObject({ source: 'heartbeat', cpu_percent: 37.5 })
    expect(Number(sample!.recorded_at) % 60_000).toBe(0)
  })

  it('store no sample when the metrics module is off, but still log the heartbeat', async () => {
    const created = await createApp({ modules: [] })
    const device = await enrollDevice(created.id, created.key.key)
    await ingest(created.id, '/heartbeat', { token: device.access_token, body: { snapshot: { cpu_percent: 10 } } })
    const samples = await env.DB.prepare('SELECT COUNT(*) AS n FROM metric_samples WHERE installation_id = ?').bind(device.installation_id).first<{ n: number }>()
    expect(samples!.n).toBe(0)
    const logged = await env.DB.prepare('SELECT COUNT(*) AS n FROM heartbeat_log WHERE installation_id = ?').bind(device.installation_id).first<{ n: number }>()
    expect(logged!.n).toBe(1)
  })

  it('record a new version and remember the previous one', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key, { app_version: '1.0.0' })
    await ingest(created.id, '/heartbeat', { token: device.access_token, body: { app_version: '1.1.0' } })
    expect((await panelJson(`/v1/installations/${device.installation_id}`)).body.data).toMatchObject({ app_version: '1.1.0', previous_app_version: '1.0.0' })
  })

  it('carry a per-installation override of the app state', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    const other = await enrollDevice(created.id, created.key.key)
    const { body } = await panelJson(`/v1/installations/${device.installation_id}`, {
      method: 'PATCH',
      body: { state_override: 'maintenance', state_message: 'Actualizando el tótem' },
    })
    expect(body.data).toMatchObject({ state_override: 'maintenance', effective_state: 'maintenance' })

    const mine = await ingestJson(created.id, '/heartbeat', { token: device.access_token, body: {} })
    expect(mine.body.data.state).toMatchObject({ state: 'maintenance', message: 'Actualizando el tótem' })
    const theirs = await ingestJson(created.id, '/heartbeat', { token: other.access_token, body: {} })
    expect(theirs.body.data.state.state).toBe('active')
  })

  it('refuse a malformed snapshot', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    expect((await ingest(created.id, '/heartbeat', { token: device.access_token, body: { snapshot: { cpu_percent: -1 } } })).status).toBe(400)
    expect((await ingest(created.id, '/heartbeat', { token: device.access_token, body: { snapshot: { memory_used_bytes: 1.5 } } })).status).toBe(400)
  })

  it('clamp a percentage that overshoots rather than refuse it', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    await ingest(created.id, '/heartbeat', { token: device.access_token, body: { snapshot: { cpu_percent: 103.4 } } })
    expect((await panelJson(`/v1/installations/${device.installation_id}`)).body.data.last_snapshot.cpu_percent).toBe(100)
  })
})

describe('heartbeats sent faster than once a minute', () => {
  const beat = (appId: string, token: string, body: Record<string, unknown>) => ingest(appId, '/heartbeat', { token, body })

  it('keep one sample per minute — the last heartbeat — and log every one of them', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-16T12:00:05Z'))
    await beat(created.id, device.access_token, { active_seconds: 5, snapshot: { cpu_percent: 10, battery_percent: 90, net_rx_bytes: 100 } })
    vi.setSystemTime(new Date('2026-10-16T12:00:25Z'))
    await beat(created.id, device.access_token, { active_seconds: 20, snapshot: { cpu_percent: 20, battery_percent: 89, net_rx_bytes: 200 } })
    vi.setSystemTime(new Date('2026-10-16T12:00:55Z'))
    await beat(created.id, device.access_token, { active_seconds: 30, snapshot: { cpu_percent: 30, battery_percent: 88, net_rx_bytes: 300 } })
    vi.setSystemTime(new Date('2026-10-16T12:01:10Z'))
    await beat(created.id, device.access_token, { active_seconds: 15, snapshot: { cpu_percent: 70, net_rx_bytes: 50 } })
    vi.useRealTimers()

    const { results } = await env.DB.prepare(
      'SELECT recorded_at, cpu_percent, battery_percent, net_rx_bytes FROM metric_samples WHERE installation_id = ? ORDER BY recorded_at',
    ).bind(device.installation_id).all()
    expect(results).toEqual([
      // Gauges are the minute's last reading; the network counter adds up everything moved in it.
      { recorded_at: Date.parse('2026-10-16T12:00:00Z'), cpu_percent: 30, battery_percent: 88, net_rx_bytes: 600 },
      // A gauge the last heartbeat did not report is N/A for its minute, not carried over.
      { recorded_at: Date.parse('2026-10-16T12:01:00Z'), cpu_percent: 70, battery_percent: null, net_rx_bytes: 50 },
    ])

    const { body } = await panelJson(`/v1/installations/${device.installation_id}/heartbeats`)
    expect(body.pagination.total).toBe(4)
    expect(body.data.map((row: any) => [row.received_at, row.active_seconds, row.snapshot.cpu_percent])).toEqual([
      ['2026-10-16T12:01:10.000Z', 15, 70],
      ['2026-10-16T12:00:55.000Z', 30, 30],
      ['2026-10-16T12:00:25.000Z', 20, 20],
      ['2026-10-16T12:00:05.000Z', 5, 10],
    ])
    // Each heartbeat after the first credited the gap since the previous one.
    expect(body.data.map((row: any) => row.credited_seconds)).toEqual([15, 30, 20, expect.any(Number)])
    expect(body.data[0].ip).toMatch(/^198\.51\.100\./)
  })

  it('chart one point per minute however often a device sends', async () => {
    const created = await createApp({ heartbeat_interval_seconds: 15 })
    const device = await enrollDevice(created.id, created.key.key)
    vi.useFakeTimers({ toFake: ['Date'] })
    for (let second = 0; second < 180; second += 10) {
      vi.setSystemTime(new Date(Date.parse('2026-10-16T12:00:00Z') + second * 1000))
      await beat(created.id, device.access_token, { snapshot: { cpu_percent: second / 2 } })
    }
    vi.setSystemTime(new Date('2026-10-16T12:05:00Z'))
    const { body } = await panelJson(`/v1/installations/${device.installation_id}/metrics?from=2026-10-16T11:59:00Z&to=2026-10-16T12:04:00Z&points=1000`)
    vi.useRealTimers()
    expect(body.data.points.map((point: any) => [point.t, point.cpu_percent, point.samples])).toEqual([
      ['2026-10-16T12:00:00.000Z', 25, 1],
      ['2026-10-16T12:01:00.000Z', 55, 1],
      ['2026-10-16T12:02:00.000Z', 85, 1],
    ])
    expect((await panelJson(`/v1/installations/${device.installation_id}/heartbeats?limit=1`)).body.pagination.total).toBe(18)
  })

  it('never overwrite a batch sample that happens to fall on the same minute boundary', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    const minute = Math.floor(Date.now() / 60_000) * 60_000
    await consumeTelemetry(env, batchOf([
      { version: 1, kind: 'metrics', installation_id: device.installation_id, app_id: created.id, received_at: 1, samples: [{ recorded_at: minute, cpu_percent: 5 }] },
    ]))
    await beat(created.id, device.access_token, { snapshot: { cpu_percent: 95 } })
    const { results } = await env.DB.prepare('SELECT source, cpu_percent FROM metric_samples WHERE installation_id = ? ORDER BY source').bind(device.installation_id).all()
    expect(results).toEqual([
      { source: 'batch', cpu_percent: 5 },
      { source: 'heartbeat', cpu_percent: 95 },
    ])
  })

  it('is purged with the rest of the raw telemetry', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    await env.DB.prepare('INSERT INTO heartbeat_log (installation_id, app_id, received_at, credited_seconds) VALUES (?, ?, ?, 0), (?, ?, ?, 0)')
      .bind(device.installation_id, created.id, Date.now() - 31 * 86_400_000, device.installation_id, created.id, Date.now())
      .run()
    const result = await runHourly(env, new Date())
    expect(result.purged.heartbeat_log).toBe(1)
    expect((await panelJson(`/v1/installations/${device.installation_id}/heartbeats`)).body.pagination.total).toBe(1)
  })
})

describe('metrics and events', () => {
  it('are queued, then stored by the consumer — once, however often a batch is redelivered', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    const now = Date.now()
    const samples = [0, 1, 2].map((index) => ({ recorded_at: new Date(now - (3 - index) * 60_000).toISOString(), cpu_percent: 10 * (index + 1), net_rx_bytes: 1000 }))
    const response = await ingestJson(created.id, '/metrics', { token: device.access_token, body: { samples } })
    expect(response.status).toBe(202)
    expect(response.body.data).toEqual({ accepted: 3, rejected: 0 })

    const messages = [...sentTelemetry()]
    await drainTelemetry()
    await consumeTelemetry(env, batchOf(messages))
    const { results } = await env.DB.prepare('SELECT cpu_percent FROM metric_samples WHERE installation_id = ? ORDER BY recorded_at').bind(device.installation_id).all()
    expect(results).toEqual([{ cpu_percent: 10 }, { cpu_percent: 20 }, { cpu_percent: 30 }])
  })

  it('reject what is dated in the future or past retention, and say how many', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    const now = Date.now()
    const samples = [
      { recorded_at: new Date(now).toISOString(), cpu_percent: 1 },
      { recorded_at: new Date(now + 3600_000).toISOString(), cpu_percent: 2 },
      { recorded_at: new Date(now - 31 * 86_400_000).toISOString(), cpu_percent: 3 },
    ]
    const { body } = await ingestJson(created.id, '/metrics', { token: device.access_token, body: { samples } })
    expect(body.data).toEqual({ accepted: 1, rejected: 2 })
  })

  it('answer 403 for a module the app has not enabled', async () => {
    const created = await createApp({ modules: ['metrics'] })
    const device = await enrollDevice(created.id, created.key.key)
    const { status, body } = await ingestJson(created.id, '/events', {
      token: device.access_token,
      body: { events: [{ id: 'e1', type: 'action', occurred_at: new Date().toISOString() }] },
    })
    expect(status).toBe(403)
    expect(body.error).toBe('The events module is not enabled for this app')
  })

  it('cap a batch at a hundred', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    const samples = Array.from({ length: 101 }, (_, index) => ({ recorded_at: new Date(Date.now() - index * 1000).toISOString() }))
    expect((await ingest(created.id, '/metrics', { token: device.access_token, body: { samples } })).status).toBe(400)
  })

  it('store events with their properties, de-duplicated by the device id', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    const events = [
      { id: 'evt-1', type: 'session_start', session_id: 's-1', occurred_at: new Date(Date.now() - 5000).toISOString() },
      { id: 'evt-2', type: 'screen', name: 'Checkout', session_id: 's-1', occurred_at: new Date().toISOString(), properties: { cart_items: 3 } },
    ]
    await ingest(created.id, '/events', { token: device.access_token, body: { events } })
    await ingest(created.id, '/events', { token: device.access_token, body: { events } })
    await drainTelemetry()

    const { body } = await panelJson(`/v1/installations/${device.installation_id}/events`)
    expect(body.pagination.total).toBe(2)
    expect(body.data[0]).toMatchObject({ id: 'evt-2', type: 'screen', name: 'Checkout', properties: { cart_items: 3 } })
    expect((await panelJson(`/v1/installations/${device.installation_id}/events?type=session_start`)).body.data.map((e: any) => e.id)).toEqual(['evt-1'])
  })

  it('refuse properties larger than the cap', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    const events = [{ id: 'big', type: 'custom', occurred_at: new Date().toISOString(), properties: { blob: 'x'.repeat(3000) } }]
    expect((await ingest(created.id, '/events', { token: device.access_token, body: { events } })).status).toBe(400)
  })

  it('drop a queue message of a shape the consumer does not know, rather than retry it forever', async () => {
    expect(await consumeTelemetry(env, batchOf([{ version: 99 }, null, 'garbage']))).toEqual({ messages: 3, rows: 0 })
  })

  it('reach the consumer through the Worker\'s queue handler', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    const message = { version: 1, kind: 'metrics', installation_id: device.installation_id, app_id: created.id, received_at: 1, samples: [{ recorded_at: Date.now(), cpu_percent: 50 }] }
    await worker.queue(batchOf([message]), env, {} as ExecutionContext)
    const row = await env.DB.prepare('SELECT cpu_percent FROM metric_samples WHERE installation_id = ?').bind(device.installation_id).first()
    expect(row).toEqual({ cpu_percent: 50 })
  })
})

describe('reading telemetry in the panel', () => {
  const seedSamples = async (installationId: string, appId: string, points: Array<{ ago: number; cpu: number; memUsed?: number; rx?: number }>) => {
    const now = Date.now()
    await consumeTelemetry(
      env,
      batchOf([
        {
          version: 1,
          kind: 'metrics',
          installation_id: installationId,
          app_id: appId,
          received_at: Math.floor(now / 1000),
          samples: points.map((point) => ({
            recorded_at: now - point.ago * 1000,
            cpu_percent: point.cpu,
            memory_used_bytes: point.memUsed ?? null,
            memory_total_bytes: point.memUsed ? 8_000 : null,
            net_rx_bytes: point.rx ?? null,
          })),
        },
      ]),
    )
  }

  it('downsample a series into buckets, averaging gauges and summing counters', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    // Buckets are aligned on the epoch, so the window is the last whole hour: a window ending "now"
    // put a bucket boundary between the two samples for 100 seconds of every hour.
    const hourStart = Math.floor(Date.now() / 3600_000) * 3600_000 - 3600_000
    const agoAt = (offsetSeconds: number) => (Date.now() - (hourStart + offsetSeconds * 1000)) / 1000
    await seedSamples(device.installation_id, created.id, [
      { ago: agoAt(100), cpu: 10, memUsed: 2_000, rx: 100 },
      { ago: agoAt(200), cpu: 30, memUsed: 6_000, rx: 300 },
    ])
    const window = `from=${new Date(hourStart).toISOString()}&to=${new Date(hourStart + 3600_000).toISOString()}`
    const { body } = await panelJson(`/v1/installations/${device.installation_id}/metrics?${window}&points=1`)
    expect(body.data.bucket_seconds).toBeGreaterThanOrEqual(3600)
    expect(body.data.points).toHaveLength(1)
    expect(body.data.points[0]).toMatchObject({ cpu_percent: 20, memory_percent: 50, net_rx_bytes: 400, gpu_percent: null, samples: 2 })
  })

  it('clamp a series to the raw retention window', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    const { body } = await panelJson(`/v1/installations/${device.installation_id}/metrics?from=2020-01-01T00:00:00Z`)
    expect(Date.parse(body.data.from)).toBeGreaterThan(Date.now() - 31 * 86_400_000)
  })

  it('compute today\'s daily row live, percentile included', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    // Twenty samples 5..100: the nearest-rank 95th percentile of twenty is the 19th, 95.
    await seedSamples(device.installation_id, created.id, Array.from({ length: 20 }, (_, index) => ({ ago: 60 + index, cpu: (index + 1) * 5 })))
    const { body } = await panelJson(`/v1/installations/${device.installation_id}/metrics/daily`)
    const today = body.data.at(-1)
    expect(today).toMatchObject({ cpu_max: 100, cpu_p95: 95, samples: 20 })
    expect(today.cpu_avg).toBeCloseTo(52.5)
  })

  it('roll a day up into a stored row, idempotently, and purge what is past retention', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    // 06:00 UTC on the 15th is 03:00 in Santiago (UTC-3): the roll-up hour.
    const now = new Date('2026-10-15T06:00:00Z')
    const yesterdayNoon = Date.parse('2026-10-14T15:00:00Z')
    await consumeTelemetry(env, batchOf([
      { version: 1, kind: 'metrics', installation_id: device.installation_id, app_id: created.id, received_at: 1, samples: [{ recorded_at: yesterdayNoon, cpu_percent: 40 }, { recorded_at: yesterdayNoon + 60_000, cpu_percent: 60 }] },
      { version: 1, kind: 'metrics', installation_id: device.installation_id, app_id: created.id, received_at: 1, samples: [{ recorded_at: now.getTime() - 40 * 86_400_000, cpu_percent: 1 }] },
    ]))
    await env.DB.prepare('INSERT INTO usage_hourly (installation_id, app_id, hour_start, online_seconds, active_seconds, heartbeats) VALUES (?, ?, ?, 3600, 1800, 60)')
      .bind(device.installation_id, created.id, yesterdayNoon / 1000).run()

    const first = await runHourly(env, now)
    expect(first.purged.metric_samples).toBe(1)
    expect(first.rolled_up).toEqual({ '2026-10-13': 0, '2026-10-14': 1 })
    await runHourly(env, now)

    const { results } = await env.DB.prepare('SELECT day, cpu_avg, cpu_max, online_seconds, active_seconds, samples FROM installation_daily WHERE installation_id = ?').bind(device.installation_id).all()
    expect(results).toEqual([{ day: '2026-10-14', cpu_avg: 50, cpu_max: 60, online_seconds: 3600, active_seconds: 1800, samples: 2 }])
  })

  it('do not roll up outside the roll-up hour', async () => {
    const result = await runHourly(env, new Date('2026-10-15T15:00:00Z'))
    expect(result.rolled_up).toEqual({})
  })

  it('run the hourly job from the Worker\'s scheduled handler', async () => {
    const waits: Promise<unknown>[] = []
    await worker.scheduled({ scheduledTime: Date.parse('2026-10-15T15:00:00Z'), cron: '0 * * * *', noRetry() {} } as ScheduledController, env, {
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
      passThroughOnException() {},
    } as unknown as ExecutionContext)
    await Promise.all(waits)
    expect(waits).toHaveLength(1)
  })

  it('give an app its daily usage, every day present', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    await setLastSeen(device.installation_id, 120)
    await ingest(created.id, '/heartbeat', { token: device.access_token, body: { active_seconds: 100 } })
    const { body } = await panelJson(`/v1/apps/${created.id}/usage`)
    expect(body.data).toHaveLength(30)
    const today = body.data.at(-1)
    expect(today.online_seconds).toBeGreaterThanOrEqual(120)
    expect(today.active_seconds).toBe(100)
    expect(today.installations).toBe(1)
    expect(body.data[0]).toMatchObject({ online_seconds: 0, installations: 0 })
  })

  it('draw the usage heatmap on Santiago\'s clock, averaging over every occurrence of the hour', async () => {
    const created = await createApp()
    const device = await enrollDevice(created.id, created.key.key)
    // Monday 2026-10-12, 15:00 UTC = 12:00 in Santiago.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-15T18:00:00Z'))
    await env.DB.prepare('INSERT INTO usage_hourly (installation_id, app_id, hour_start, online_seconds, active_seconds, heartbeats) VALUES (?, ?, ?, 3600, 3000, 60)')
      .bind(device.installation_id, created.id, Date.parse('2026-10-12T15:00:00Z') / 1000).run()
    const { body } = await panelJson(`/v1/apps/${created.id}/usage/heatmap`)
    vi.useRealTimers()
    expect(body.data.timezone).toBe('America/Santiago')
    expect(body.data.cells).toHaveLength(7)
    expect(body.data.cells[0]).toHaveLength(24)
    // Thirty days hold four or five Mondays; one of them had 3000 s at noon.
    expect([600, 750]).toContain(body.data.cells[0][12])
    expect(body.data.max).toBe(body.data.cells[0][12])
    expect(body.data.cells[0][11]).toBe(0)
  })
})
