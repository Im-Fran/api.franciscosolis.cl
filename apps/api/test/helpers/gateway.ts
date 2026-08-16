import { SELF, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import app from '@/index'
import type { Env } from '@/env'
import type { EchoedRequest } from '../stubs'

/** Every test dispatches against the real hostname, so nothing depends on a test-only origin. */
const BASE_URL = 'https://api.franciscosolis.cl'

type GatewayInit = Parameters<typeof SELF.fetch>[1]

/** Dispatches into the deployed gateway over its service binding, the way a client would. */
const gateway = (path: string, init?: GatewayInit) => SELF.fetch(new URL(path, BASE_URL).toString(), init)

/**
 * Dispatches into the Hono app directly with one or more bindings swapped out. `SELF` always hands
 * the gateway the healthy stub Workers, so this is the only way to see what it does when an
 * internal module is unreachable or answers garbage.
 */
const gatewayWithBindings = async (bindings: Partial<Env>, path: string, init?: RequestInit) => {
  const ctx = createExecutionContext()
  const response = await app.fetch(
    new Request(new URL(path, BASE_URL).toString(), init),
    { ...env, ...bindings } as unknown as Env,
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return response
}

/** A stand-in service binding whose `fetch` does whatever the test needs. */
const fetcher = (handler: (request: Request) => Response | Promise<Response>) =>
  ({ fetch: handler } as unknown as Fetcher)

/** Reads back the request an echo stub received, asserting it really came from one. */
const echoOf = async (response: Response): Promise<EchoedRequest> => {
  const module = response.headers.get('X-Stub-Module')
  if (module === null) {
    throw new Error(`expected a proxied echo response, got ${response.status} ${await response.text()}`)
  }
  return response.json<EchoedRequest>()
}

export { BASE_URL, echoOf, fetcher, gateway, gatewayWithBindings }
