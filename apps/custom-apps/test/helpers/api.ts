import { env, SELF } from 'cloudflare:test'
import { asAdmin } from './tokens'
import type { AccessTokenClaims } from '@/lib/jwks'

/** The gateway's host, as far as this Worker can tell: anything that is not the ingest host. */
const PANEL = 'https://api.franciscosolis.cl/custom-apps'
/** The ingest base the Worker is configured with, which is what a client app is given. */
const INGEST = () => env.INGEST_PUBLIC_URL

type Json = Record<string, any>

/**
 * A panel request as the gateway forwards it: with the `/custom-apps` prefix already stripped, but
 * the original host kept — `apps/api` only ever rewrites the path.
 */
type PanelInit = Omit<RequestInit, 'body'> & { as?: Partial<AccessTokenClaims>; body?: any }

const panel = async (path: string, init: PanelInit = {}) => {
  const { as, body, ...rest } = init
  const url = new URL(path, 'https://api.franciscosolis.cl')
  return SELF.fetch(url, {
    ...rest,
    headers: { ...(await asAdmin(as)), ...((rest.headers as Record<string, string>) ?? {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const panelJson = async (path: string, init: PanelInit = {}) => {
  const response = await panel(path, init)
  return { status: response.status, body: (await response.json()) as Json, response }
}

/** A device request, on the ingest host. */
type IngestInit = Omit<RequestInit, 'body'> & { token?: string; body?: any; ip?: string }

/** A body as `fetch` takes it: JSON for plain values, bytes and strings as they are. */
const encodeBody = (body: unknown): BodyInit | undefined => {
  if (body === undefined) return undefined
  if (typeof body === 'string' || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof Blob) return body as BodyInit
  return JSON.stringify(body)
}

const ingest = (appId: string, path: string, init: IngestInit = {}) => {
  const { token, body, ip, ...rest } = init
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': ip ?? `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
    ...((rest.headers as Record<string, string>) ?? {}),
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return SELF.fetch(`${INGEST()}/${appId}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...rest,
    headers,
    body: encodeBody(body),
  })
}

const ingestJson = async (appId: string, path: string, init: IngestInit = {}) => {
  const response = await ingest(appId, path, init)
  return { status: response.status, body: (await response.json()) as Json, response }
}

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const createCompany = async (overrides: Json = {}) => {
  const { status, body } = await panelJson('/v1/companies', { method: 'POST', body: { legal_name: 'Comercial Andes SpA', rut: '76.086.428-5', ...overrides } })
  if (status !== 201) throw new Error(`createCompany answered ${status}: ${JSON.stringify(body)}`)
  return body.data as Json
}

const createApp = async (overrides: Json = {}) => {
  const companyId = overrides.company_id ?? (await createCompany()).id
  const { status, body } = await panelJson('/v1/apps', {
    method: 'POST',
    body: { company_id: companyId, name: 'POS Andes', kind: 'kiosk', modules: ['metrics', 'events'], ...overrides },
  })
  if (status !== 201) throw new Error(`createApp answered ${status}: ${JSON.stringify(body)}`)
  return body.data as Json
}

/** Enrolls a device and returns the tokens the ingest surface answered with. */
const enrollDevice = async (appId: string, appKey: string, overrides: Json = {}) => {
  const { status, body } = await ingestJson(appId, '/enroll', {
    body: { app_key: appKey, device_id: `device-${crypto.randomUUID()}`, platform: 'windows', os_name: 'Windows', os_version: '11', arch: 'x86_64', app_version: '1.0.0', ...overrides },
  })
  if (status !== 201 && status !== 200) throw new Error(`enroll answered ${status}: ${JSON.stringify(body)}`)
  return body.data as Json
}

export { createApp, createCompany, enrollDevice, ingest, INGEST, ingestJson, PANEL, panel, panelJson }
export type { Json }
