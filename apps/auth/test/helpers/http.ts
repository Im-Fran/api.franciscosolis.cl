import { vi } from 'vitest'

type RecordedRequest = {
  url: string
  method: string
  body: string | null
  headers: Record<string, string>
  /**
   * The `RequestInit` exactly as the caller handed it to `fetch`. Kept alongside the normalized
   * fields because Cloudflare-only options (`cf`) never survive the round trip through `Request`,
   * and they are the only way to assert on caching hints.
   */
  init: RequestInit | undefined
}

type RouteHandler = (request: RecordedRequest) => Response | Promise<Response>

/**
 * Replaces the global `fetch` for the duration of a test.
 *
 * This is the only interception point that works here: the Worker's modules are loaded by workerd
 * rather than by Vite, so `vi.mock('axios', …)` never reaches them — but axios uses the fetch
 * adapter inside workerd, so stubbing `fetch` catches both axios calls and `verifyWithJwks`.
 * Anything the test did not declare a route for throws, so an unexpected outbound call is a test
 * failure rather than a real network request.
 */
const stubFetch = (routes: Record<string, RouteHandler>) => {
  const calls: RecordedRequest[] = []

  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init)
    const recorded: RecordedRequest = {
      url: request.url,
      method: request.method,
      // Decoded by hand rather than with `.text()`, which warns for form-encoded bodies.
      body: request.body ? new TextDecoder().decode(await request.clone().arrayBuffer()) : null,
      headers: Object.fromEntries(request.headers),
      init,
    }
    calls.push(recorded)

    const match = Object.entries(routes).find(([prefix]) => recorded.url.startsWith(prefix))
    if (!match) {
      throw new Error(`unexpected outbound request: ${recorded.method} ${recorded.url}`)
    }
    return match[1](recorded)
  })

  vi.stubGlobal('fetch', stub)
  return { calls, stub }
}

const restoreFetch = () => vi.unstubAllGlobals()

export { restoreFetch, stubFetch }
export type { RecordedRequest }
