import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { vi } from 'vitest'
import worker from '@/index'

/**
 * Drives the `email()` handler the way Cloudflare would.
 *
 * Miniflare cannot dispatch an email event, so `SELF` is useless here — but the handler is an
 * exported function, and a `ForwardableEmailMessage` is a small enough interface to build. Calling
 * it directly covers the real path, `PostalMime.parse` included, which is what makes the thin
 * handler worth having.
 */
const deliver = async (raw: string, overrides: { to?: string; from?: string; rawSize?: number } = {}) => {
  const setReject = vi.fn()
  const forward = vi.fn()
  const reply = vi.fn()

  const headers = new Headers()
  for (const line of raw.split('\r\n')) {
    if (line === '') {
      break
    }
    const index = line.indexOf(':')
    if (index > 0) {
      headers.set(line.slice(0, index).trim(), line.slice(index + 1).trim())
    }
  }

  const message = {
    from: overrides.from ?? 'someone@example.test',
    to: overrides.to ?? 'soporte@franciscosolis.cl',
    headers,
    raw: new Response(raw).body!,
    rawSize: overrides.rawSize ?? raw.length,
    setReject,
    forward,
    reply,
  }

  const ctx = createExecutionContext()
  await worker.email!(message as unknown as ForwardableEmailMessage, env, ctx)
  await waitOnExecutionContext(ctx)

  return { setReject, forward, reply }
}

export { deliver }
