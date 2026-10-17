import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { mintDownloadTicket } from '@/lib/download-tickets'
import { evaluateAlerts } from '@/services/alerts'
import { evaluateRollouts, runScheduled } from '@/services/maintenance'
import { rolloutBucket } from '@/services/releases'
import { createApp, enrollDevice, ingest, ingestJson, panel, panelJson, type Json } from '../helpers/api'
import { drainTelemetry } from '../helpers/telemetry'

/* ── Signing, as CI does it ───────────────────────────────────────────────── */

const toBase64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

const releaseKeyPair = async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const publicKey = toBase64((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
  /** Ed25519 over the raw SHA-256 digest of the artifact, base64 — what the CI step sends. */
  const sign = async (artifact: Uint8Array) => {
    const digest = await crypto.subtle.digest('SHA-256', artifact)
    return { signature: toBase64(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, digest)), sha256: hex(digest) }
  }
  return { publicKey, sign }
}

const artifact = (text: string) => new TextEncoder().encode(text.repeat(64))

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const setup = async (overrides: Json = {}) => {
  const created = await createApp({ modules: ['updates', 'crashes'], ...overrides })
  const keys = await releaseKeyPair()
  expect((await panelJson(`/v1/apps/${created.id}`, { method: 'PATCH', body: { release_public_key: keys.publicKey } })).status).toBe(200)
  const token = (await panelJson(`/v1/apps/${created.id}/ci-tokens`, { method: 'POST', body: { label: 'GitHub Actions' } })).body.data
  return { app: created, keys, ci: token as Json }
}

type UploadInit = { version?: string; channel?: string; platform?: string; arch?: string; filename?: string; min_version?: string; headers?: Record<string, string> }

const upload = (appId: string, ciToken: string, bytes: Uint8Array, signature: string | null, init: UploadInit = {}) => {
  const query = new URLSearchParams({
    version: init.version ?? '1.1.0',
    platform: init.platform ?? 'windows',
    arch: init.arch ?? 'x86_64',
    filename: init.filename ?? 'pos-setup.msi',
    ...(init.channel && { channel: init.channel }),
    ...(init.min_version && { min_version: init.min_version }),
  })
  return SELF.fetch(`https://api.franciscosolis.cl/v1/apps/${appId}/releases/upload?${query}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ciToken}`,
      'Content-Type': 'application/x-msi',
      'Content-Length': String(bytes.byteLength),
      ...(signature && { 'X-Signature': signature }),
      ...init.headers,
    },
    body: bytes,
  })
}

/** Uploads and signs a build, then publishes it. Answers the release as the panel shows it. */
const release = async (ctx: Awaited<ReturnType<typeof setup>>, version: string, publish: Json | null = { rollout_percent: 100 }, init: UploadInit = {}) => {
  const bytes = artifact(`build ${version} `)
  const { signature } = await ctx.keys.sign(bytes)
  const response = await upload(ctx.app.id, ctx.ci.token, bytes, signature, { version, ...init })
  const body = (await response.json()) as Json
  if (response.status !== 201) throw new Error(`upload answered ${response.status}: ${JSON.stringify(body)}`)
  if (!publish) return body.data as Json
  const published = await panelJson(`/v1/releases/${body.data.id}/publish`, { method: 'POST', body: publish })
  if (published.status !== 200) throw new Error(`publish answered ${published.status}: ${JSON.stringify(published.body)}`)
  return published.body.data as Json
}

const latest = async (appId: string, token: string, query = '') => (await ingestJson(appId, `/updates/latest${query}`, { token })).body.data
const heartbeat = async (appId: string, token: string, body: Json = {}) => (await ingestJson(appId, '/heartbeat', { token, body })).body.data
const report = (appId: string, token: string, releaseId: string, status: string, extra: Json = {}) =>
  ingestJson(appId, `/updates/${releaseId}/report`, { token, body: { status, ...extra } })

const objectCount = async (appId: string) => (await env.RELEASES.list({ prefix: `releases/${appId}/` })).objects.length

/* ── Tests ────────────────────────────────────────────────────────────────── */

describe('uploading from CI', () => {
  it('stores a signed build as a draft, checksummed and audited', async () => {
    const ctx = await setup()
    const bytes = artifact('pos ')
    const { signature, sha256 } = await ctx.keys.sign(bytes)
    const response = await upload(ctx.app.id, ctx.ci.token, bytes, signature, { headers: { 'X-Sha256': sha256 }, min_version: '1.0.0' })
    expect(response.status).toBe(201)
    const { data } = (await response.json()) as Json
    expect(data).toMatchObject({
      app_id: ctx.app.id,
      version: '1.1.0',
      channel: 'stable',
      platform: 'windows',
      arch: 'x86_64',
      status: 'draft',
      rollout_percent: 0,
      min_version: '1.0.0',
      filename: 'pos-setup.msi',
      content_type: 'application/x-msi',
      size_bytes: bytes.byteLength,
      sha256,
      signature,
      uploaded_by: `ci:${ctx.ci.id}`,
    })
    const stored = await env.RELEASES.get(`releases/${ctx.app.id}/${data.id}/pos-setup.msi`)
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes)

    const audit = await env.DB.prepare("SELECT metadata FROM audit_logs WHERE resource_id = ? AND event = 'release.uploaded'").bind(ctx.app.id).first<{ metadata: string }>()
    expect(JSON.parse(audit!.metadata)).toMatchObject({ release_id: data.id, ci_token_id: ctx.ci.id, sha256 })
    const tokens = (await panelJson(`/v1/apps/${ctx.app.id}/ci-tokens`)).body.data
    expect(tokens[0]).toMatchObject({ label: 'GitHub Actions', token_prefix: ctx.ci.token.slice(0, 12) })
    expect(tokens[0].last_used_at).not.toBeNull()
    expect(tokens[0]).not.toHaveProperty('token')

    // The same version on the same line is refused; on another line it is a different release.
    expect((await upload(ctx.app.id, ctx.ci.token, bytes, signature)).status).toBe(409)
    expect((await upload(ctx.app.id, ctx.ci.token, bytes, signature, { channel: 'beta' })).status).toBe(201)
  })

  it('refuses a build the devices would refuse, and keeps none of its bytes', async () => {
    const ctx = await setup()
    const bytes = artifact('pos ')
    const other = await releaseKeyPair()
    const { signature: foreign } = await other.sign(bytes)
    expect((await upload(ctx.app.id, ctx.ci.token, bytes, foreign)).status).toBe(422)
    const { signature } = await ctx.keys.sign(artifact('something else '))
    expect((await upload(ctx.app.id, ctx.ci.token, bytes, signature)).status).toBe(422)
    const { signature: good } = await ctx.keys.sign(bytes)
    expect((await upload(ctx.app.id, ctx.ci.token, bytes, good, { headers: { 'X-Sha256': '0'.repeat(64) } })).status).toBe(422)
    expect((await upload(ctx.app.id, ctx.ci.token, bytes, null)).status).toBe(422)
    expect((await upload(ctx.app.id, ctx.ci.token, bytes, good, { version: 'latest' })).status).toBe(400)
    expect(await objectCount(ctx.app.id)).toBe(0)
    expect((await panelJson(`/v1/apps/${ctx.app.id}/releases`)).body.pagination.total).toBe(0)
  })

  it('takes nothing but a live CI token of the app in the path', async () => {
    const ctx = await setup()
    const otherApp = await setup({ company_id: ctx.app.company_id })
    const bytes = artifact('pos ')
    const { signature } = await ctx.keys.sign(bytes)
    expect((await upload(ctx.app.id, 'cic_not-a-real-token', bytes, signature)).status).toBe(401)
    expect((await upload(ctx.app.id, otherApp.ci.token, bytes, signature)).status).toBe(401)
    expect((await upload(ctx.app.id, ctx.app.key.key, bytes, signature)).status).toBe(401)

    await panelJson(`/v1/ci-tokens/${ctx.ci.id}/revoke`, { method: 'POST' })
    expect((await upload(ctx.app.id, ctx.ci.token, bytes, signature)).status).toBe(401)
    const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE resource_id = ? AND event = 'ci_token.revoked'").bind(ctx.app.id).first<{ n: number }>()
    expect(audit!.n).toBe(1)
  })

  it('needs a release key first, and only accepts a real one', async () => {
    const created = await createApp({ modules: ['updates'] })
    const token = (await panelJson(`/v1/apps/${created.id}/ci-tokens`, { method: 'POST' })).body.data.token
    const bytes = artifact('pos ')
    expect((await upload(created.id, token, bytes, 'c2lnbmF0dXJl')).status).toBe(409)
    expect((await panelJson(`/v1/apps/${created.id}`, { method: 'PATCH', body: { release_public_key: 'bm90IGEga2V5' } })).status).toBe(400)
    const app = (await panelJson(`/v1/apps/${created.id}`)).body.data
    expect(app).toMatchObject({ release_public_key: null, update_health_timeout_seconds: 600, update_max_failures: 3, rollout_pause_rollback_percent: 20, rollout_pause_crash_percent: 20 })
  })
})

describe('the offer', () => {
  it('reaches the installations a rollout names, then the percentage, and rides the heartbeat', async () => {
    const ctx = await setup()
    const first = await enrollDevice(ctx.app.id, ctx.app.key.key)
    const second = await enrollDevice(ctx.app.id, ctx.app.key.key)
    const draft = await release(ctx, '1.1.0', null)
    expect(await latest(ctx.app.id, first.access_token)).toBeNull()

    await panelJson(`/v1/releases/${draft.id}/publish`, { method: 'POST', body: { rollout_percent: 0, installation_ids: [first.installation_id] } })
    const offer = await latest(ctx.app.id, first.access_token)
    expect(offer).toMatchObject({ release_id: draft.id, version: '1.1.0', mandatory: false, rollback: false, sha256: draft.sha256, signature: draft.signature, health_check_timeout_seconds: 600, max_failures: 3 })
    expect(await latest(ctx.app.id, second.access_token)).toBeNull()
    expect((await heartbeat(ctx.app.id, first.access_token)).update).toEqual({ release_id: draft.id, version: '1.1.0', mandatory: false, rollback: false })
    expect((await heartbeat(ctx.app.id, second.access_token)).update).toBeNull()

    await panelJson(`/v1/releases/${draft.id}/rollout`, { method: 'POST', body: { rollout_percent: 100 } })
    expect(await latest(ctx.app.id, second.access_token)).toMatchObject({ release_id: draft.id })
    // A device already on it, or past it, is offered nothing.
    expect((await heartbeat(ctx.app.id, second.access_token, { app_version: '1.1.0' })).update).toBeNull()
    expect(await latest(ctx.app.id, first.access_token, '?version=1.2.0')).toBeNull()
  })

  it('splits a percentage by a bucket that stays the same for every release', async () => {
    const ctx = await setup()
    const device = await enrollDevice(ctx.app.id, ctx.app.key.key)
    const bucket = await rolloutBucket(ctx.app.id, device.installation_id)
    const published = await release(ctx, '1.1.0', { rollout_percent: bucket })
    expect(await latest(ctx.app.id, device.access_token)).toBeNull()
    await panelJson(`/v1/releases/${published.id}/rollout`, { method: 'POST', body: { rollout_percent: bucket + 1 } })
    expect(await latest(ctx.app.id, device.access_token)).toMatchObject({ release_id: published.id })
    expect(await rolloutBucket(ctx.app.id, device.installation_id)).toBe(bucket)
  })

  it('follows the line: channel, platform and a normalised architecture', async () => {
    const ctx = await setup()
    const device = await enrollDevice(ctx.app.id, ctx.app.key.key, { arch: 'amd64' })
    await release(ctx, '1.1.0', { rollout_percent: 100 }, { arch: 'aarch64' })
    await release(ctx, '1.2.0', { rollout_percent: 100 }, { channel: 'beta' })
    await release(ctx, '1.3.0', { rollout_percent: 100 }, { platform: 'linux' })
    expect(await latest(ctx.app.id, device.access_token)).toBeNull()
    const universal = await release(ctx, '1.0.5', { rollout_percent: 100 }, { arch: 'universal' })
    expect(await latest(ctx.app.id, device.access_token)).toMatchObject({ release_id: universal.id })
    const native = await release(ctx, '1.1.1')
    expect(await latest(ctx.app.id, device.access_token)).toMatchObject({ release_id: native.id })
    expect(await latest(ctx.app.id, device.access_token, '?arch=arm64')).toMatchObject({ version: '1.1.0' })
    const detail = (await panelJson(`/v1/releases/${native.id}`)).body.data
    expect(detail).toMatchObject({ installations_on_line: 1, installations_on_version: 0 })
  })

  it('is mandatory below the minimum version', async () => {
    const ctx = await setup()
    const device = await enrollDevice(ctx.app.id, ctx.app.key.key)
    const published = await release(ctx, '2.0.0')
    expect(await latest(ctx.app.id, device.access_token)).toMatchObject({ mandatory: false })
    expect((await panelJson(`/v1/releases/${published.id}`, { method: 'PATCH', body: { min_version: '1.5.0' } })).status).toBe(200)
    expect(await latest(ctx.app.id, device.access_token)).toMatchObject({ mandatory: true, min_version: '1.5.0' })
    expect((await panelJson(`/v1/releases/${published.id}`, { method: 'PATCH', body: { min_version: '3.0.0' } })).status).toBe(400)
  })

  it('stops during grace, and needs the module', async () => {
    const ctx = await setup()
    const device = await enrollDevice(ctx.app.id, ctx.app.key.key)
    await release(ctx, '1.1.0')
    await panel(`/v1/apps/${ctx.app.id}/status`, { method: 'PUT', body: { state: 'grace', until: new Date(Date.now() + 86_400_000).toISOString() } })
    expect(await latest(ctx.app.id, device.access_token)).toBeNull()
    expect((await heartbeat(ctx.app.id, device.access_token)).update).toBeNull()

    await panel(`/v1/apps/${ctx.app.id}`, { method: 'PATCH', body: { modules: ['crashes'] } })
    expect((await ingest(ctx.app.id, '/updates/latest', { token: device.access_token })).status).toBe(403)
    const paths = Object.keys(((await ingestJson(ctx.app.id, '/openapi.json')).body as { paths: Record<string, unknown> }).paths)
    expect(paths.some((path) => path.startsWith('/updates') || path.startsWith('/downloads'))).toBe(false)
  })
})

describe('downloading', () => {
  it('trades the bearer token for a short-lived link that serves ranges', async () => {
    const ctx = await setup()
    const device = await enrollDevice(ctx.app.id, ctx.app.key.key)
    const published = await release(ctx, '1.1.0')
    const link = await ingestJson(ctx.app.id, `/updates/${published.id}/download`, { token: device.access_token })
    expect(link.status).toBe(200)
    expect(link.body.data).toMatchObject({ size_bytes: published.size_bytes, sha256: published.sha256 })
    const url = link.body.data.url as string
    expect(url.startsWith(`${env.INGEST_PUBLIC_URL}/${ctx.app.id}/downloads/`)).toBe(true)

    const full = await SELF.fetch(url)
    expect(full.status).toBe(200)
    expect(full.headers.get('Accept-Ranges')).toBe('bytes')
    const bytes = new Uint8Array(await full.arrayBuffer())
    expect(hex(await crypto.subtle.digest('SHA-256', bytes))).toBe(published.sha256)

    const part = await SELF.fetch(url, { headers: { Range: 'bytes=10-19' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('Content-Range')).toBe(`bytes 10-19/${published.size_bytes}`)
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(10, 20))
    const tail = await SELF.fetch(url, { headers: { Range: 'bytes=-5' } })
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.slice(-5))
    expect((await SELF.fetch(url, { headers: { Range: `bytes=${published.size_bytes}-` } })).status).toBe(416)
  })

  it('refuses an expired link, one used under another app, and a draft', async () => {
    const ctx = await setup()
    const device = await enrollDevice(ctx.app.id, ctx.app.key.key)
    const published = await release(ctx, '1.1.0')
    const old = await mintDownloadTicket(env.UPDATE_DOWNLOAD_SECRET!, { r: published.id, a: ctx.app.id, i: device.installation_id }, new Date(Date.now() - 3_600_000))
    expect((await ingest(ctx.app.id, `/downloads/${old.ticket}`)).status).toBe(404)
    const fresh = await mintDownloadTicket(env.UPDATE_DOWNLOAD_SECRET!, { r: published.id, a: ctx.app.id, i: device.installation_id })
    const other = await setup({ company_id: ctx.app.company_id })
    expect((await ingest(other.app.id, `/downloads/${fresh.ticket}`)).status).toBe(404)
    const draft = await release(ctx, '1.2.0', null)
    expect((await ingest(ctx.app.id, `/updates/${draft.id}/download`, { token: device.access_token })).status).toBe(404)
  })
})

describe('reports and the automatic pause', () => {
  it('count devices once per step and pause a release that rolls back too often', async () => {
    const ctx = await setup()
    const devices = await Promise.all([1, 2, 3, 4].map(() => enrollDevice(ctx.app.id, ctx.app.key.key)))
    const published = await release(ctx, '1.1.0')
    for (const [index, device] of devices.entries()) {
      await report(ctx.app.id, device.access_token, published.id, 'downloaded')
      await report(ctx.app.id, device.access_token, published.id, 'downloaded')
      await report(ctx.app.id, device.access_token, published.id, 'installed', { from_version: '1.0.0' })
      if (index === 0) await report(ctx.app.id, device.access_token, published.id, 'health_ok')
    }
    // One healthy out of one settled: no rate to act on yet, the sample is too small.
    expect(await evaluateRollouts(env, new Date())).toBe(0)

    for (const device of devices.slice(1)) {
      const answer = await report(ctx.app.id, device.access_token, published.id, 'rolled_back', { detail: 'health check timed out' })
      expect(answer.status).toBe(202)
    }
    const detail = (await panelJson(`/v1/releases/${published.id}`)).body.data
    expect(detail.stats).toMatchObject({ downloaded: 4, installed: 4, health_ok: 1, rolled_back: 3, failed: 0, rollback_rate: 75 })
    const listed = (await panelJson(`/v1/apps/${ctx.app.id}/releases`)).body.data[0]
    expect(listed).toMatchObject({ installed_count: 4, healthy_count: 1, rolled_back_count: 3 })

    const result = await runScheduled(env, new Date())
    expect(result.paused_releases).toBe(1)
    const paused = (await panelJson(`/v1/releases/${published.id}`)).body.data
    expect(paused).toMatchObject({ status: 'paused', status_reason: { automatic: true, reason: 'rollback_rate', rate: 75, threshold: 20, sample: 4 } })
    // Paused means nobody new is offered it, but the devices that have it can still fetch it.
    expect(await latest(ctx.app.id, devices[0]!.access_token, '?version=1.0.0')).toBeNull()
    expect((await ingest(ctx.app.id, `/updates/${published.id}/download`, { token: devices[0]!.access_token })).status).toBe(200)
    const audit = await env.DB.prepare("SELECT actor_email, metadata FROM audit_logs WHERE resource_id = ? AND event = 'release.paused'").bind(ctx.app.id).first<{ actor_email: string | null; metadata: string }>()
    expect(audit!.actor_email).toBeNull()
    expect(JSON.parse(audit!.metadata)).toMatchObject({ release_id: published.id, automatic: true, reason: 'rollback_rate' })

    const reports = await panelJson(`/v1/releases/${published.id}/reports`)
    expect(reports.body.pagination.total).toBe(16)
    expect(reports.body.data[0]).toMatchObject({ status: 'rolled_back', detail: 'health check timed out' })

    const own = (await panelJson(`/v1/installations/${devices[1]!.installation_id}/updates`)).body
    expect(own.data.offer).toBeNull()
    expect(own.data.reports[0]).toMatchObject({ status: 'rolled_back', version: '1.1.0' })
    expect(own.pagination.total).toBe(4)
  })

  it('pause a release its devices crash on', async () => {
    const ctx = await setup()
    const devices = await Promise.all([1, 2, 3].map(() => enrollDevice(ctx.app.id, ctx.app.key.key)))
    const published = await release(ctx, '1.1.0')
    for (const device of devices) {
      await report(ctx.app.id, device.access_token, published.id, 'installed')
      await ingestJson(ctx.app.id, '/crashes', {
        token: device.access_token,
        body: { crashes: [{ id: crypto.randomUUID(), occurred_at: new Date().toISOString(), app_version: '1.1.0', kind: 'panic', message: 'boom', stack: null }] },
      })
    }
    await drainTelemetry()
    expect((await panelJson(`/v1/releases/${published.id}`)).body.data.stats).toMatchObject({ crashed: 3, crash_rate: 100 })
    expect(await evaluateRollouts(env, new Date())).toBe(1)
    expect((await panelJson(`/v1/releases/${published.id}`)).body.data.status_reason).toMatchObject({ reason: 'crash_rate' })
  })

  it('open a release_rollbacks alert', async () => {
    const ctx = await setup()
    const device = await enrollDevice(ctx.app.id, ctx.app.key.key)
    const published = await release(ctx, '1.1.0')
    await panelJson('/v1/alert-rules', { method: 'POST', body: { name: 'Rollbacks', kind: 'release_rollbacks', threshold: 1, app_id: ctx.app.id } })
    await report(ctx.app.id, device.access_token, published.id, 'rolled_back')
    expect(await evaluateAlerts(env)).toMatchObject({ opened: 1 })
    const [alert] = (await panelJson('/v1/alerts?status=unresolved')).body.data
    expect(alert).toMatchObject({ kind: 'release_rollbacks', value: 1 })
  })

  it('refuse a report about another app’s release', async () => {
    const ctx = await setup()
    const other = await setup({ company_id: ctx.app.company_id })
    const device = await enrollDevice(ctx.app.id, ctx.app.key.key)
    const foreign = await release(other, '1.1.0')
    expect((await report(ctx.app.id, device.access_token, foreign.id, 'installed')).status).toBe(404)
  })
})

describe('withdrawing and rolling back', () => {
  it('sends devices on a withdrawn version back to the previous one', async () => {
    const ctx = await setup()
    const device = await enrollDevice(ctx.app.id, ctx.app.key.key)
    const previous = await release(ctx, '1.1.0')
    const bad = await release(ctx, '1.2.0')
    expect((await heartbeat(ctx.app.id, device.access_token, { app_version: '1.2.0' })).update).toBeNull()

    const withdrawn = await panelJson(`/v1/releases/${bad.id}/withdraw`, { method: 'POST', body: { reason: 'printer driver crash' } })
    expect(withdrawn.body.data).toMatchObject({ status: 'withdrawn', status_reason: { by: 'fran@franciscosolis.cl', automatic: false, reason: 'printer driver crash' } })
    expect((await heartbeat(ctx.app.id, device.access_token)).update).toEqual({ release_id: previous.id, version: '1.1.0', mandatory: true, rollback: true })
    expect((await panelJson(`/v1/releases/${bad.id}/withdraw`, { method: 'POST' })).status).toBe(409)
    expect((await panelJson(`/v1/releases/${bad.id}/resume`, { method: 'POST' })).status).toBe(409)
  })

  it('rolls a whole line back to an earlier release', async () => {
    const ctx = await setup()
    const device = await enrollDevice(ctx.app.id, ctx.app.key.key, { app_version: '1.3.0' })
    const target = await release(ctx, '1.1.0', { rollout_percent: 0 })
    const middle = await release(ctx, '1.2.0')
    const newest = await release(ctx, '1.3.0')
    const rolled = await panelJson(`/v1/releases/${target.id}/rollback`, { method: 'POST', body: { reason: 'regression in 1.2' } })
    expect(rolled.status).toBe(200)
    expect(rolled.body.data).toMatchObject({ status: 'published', rollout_percent: 100 })
    for (const id of [middle.id, newest.id]) {
      expect((await panelJson(`/v1/releases/${id}`)).body.data).toMatchObject({ status: 'withdrawn', status_reason: { rolled_back_to: '1.1.0' } })
    }
    expect(await latest(ctx.app.id, device.access_token)).toMatchObject({ release_id: target.id, rollback: true, mandatory: true })
    const audit = await env.DB.prepare("SELECT metadata FROM audit_logs WHERE resource_id = ? AND event = 'release.rolled_back'").bind(ctx.app.id).first<{ metadata: string }>()
    expect(JSON.parse(audit!.metadata).withdrawn).toHaveLength(2)
    const draft = await release(ctx, '1.4.0', null)
    expect((await panelJson(`/v1/releases/${draft.id}/rollback`, { method: 'POST' })).status).toBe(409)
  })

  it('deletes only drafts, with their bytes', async () => {
    const ctx = await setup()
    const draft = await release(ctx, '1.1.0', null)
    const published = await release(ctx, '1.2.0')
    const artifactResponse = await panel(`/v1/releases/${draft.id}/artifact`)
    expect(artifactResponse.status).toBe(200)
    expect(artifactResponse.headers.get('Content-Disposition')).toContain('pos-setup.msi')
    await artifactResponse.arrayBuffer()
    expect((await panelJson(`/v1/releases/${published.id}`, { method: 'DELETE' })).status).toBe(409)
    expect((await panelJson(`/v1/releases/${draft.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(await objectCount(ctx.app.id)).toBe(1)
    expect((await panelJson(`/v1/releases/${published.id}/publish`, { method: 'POST', body: { rollout_percent: 10 } })).status).toBe(409)
  })
})

describe('the overview', () => {
  it('counts releases rolling out, paused and in draft', async () => {
    const ctx = await setup()
    await release(ctx, '1.0.0', null)
    await release(ctx, '1.1.0', { rollout_percent: 25 })
    const paused = await release(ctx, '1.2.0')
    await panelJson(`/v1/releases/${paused.id}/pause`, { method: 'POST' })
    expect((await panelJson('/v1/overview')).body.data.releases).toEqual({ rolling_out: 1, paused: 1, drafts: 1 })
  })
})
