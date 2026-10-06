import { env } from 'cloudflare:test'
import { vi } from 'vitest'
import type { NotificationEvent } from '@/services/ingest'

/** A well-formed event, the way `apps/auth` publishes a sign-in. */
const makeEvent = (overrides: Partial<NotificationEvent> = {}): NotificationEvent => ({
  version: 1,
  id: crypto.randomUUID(),
  type: 'account.sign_in',
  user: { id: 'user-1', email: 'someone@example.test', name: 'Someone', locale: 'es' },
  occurred_at: new Date().toISOString(),
  data: {
    application_name: 'Francisco Solis',
    provider_name: 'Magic Link',
    device: 'Chrome on macOS',
    location: 'Santiago, Chile',
    ip_address: '203.0.113.24',
  },
  url: '/account/sessions',
  ...overrides,
})

type FakeMessage = {
  id: string
  body: unknown
  ack: ReturnType<typeof vi.fn>
  retry: ReturnType<typeof vi.fn>
}

/**
 * A `MessageBatch` built by hand, so the consumer's per-message ack/retry decisions can be asserted
 * on directly rather than inferred from what a simulated queue did afterwards.
 */
const makeBatch = (bodies: unknown[]) => {
  const messages: FakeMessage[] = bodies.map((body, index) => ({
    id: `m-${index}`,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  }))
  const batch = {
    queue: 'franciscosolis-notifications',
    messages: messages.map((message) => ({ ...message, timestamp: new Date(), attempts: 1 })),
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>
  return { batch, messages }
}

/** A fresh P-256 VAPID key, installed as the Worker's secret. Returns the JWK. */
const installVapidKey = async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey
  ;(env as { VAPID_PRIVATE_KEY?: string }).VAPID_PRIVATE_KEY = JSON.stringify(jwk)
  return { jwk, publicKey: pair.publicKey }
}

const removeVapidKey = () => {
  ;(env as { VAPID_PRIVATE_KEY?: string }).VAPID_PRIVATE_KEY = undefined
}

export { installVapidKey, makeBatch, makeEvent, removeVapidKey }
export type { FakeMessage }
