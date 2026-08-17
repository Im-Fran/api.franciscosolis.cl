/**
 * Registry of the internal Workers this gateway fronts.
 *
 * Everything the gateway does per module is derived from this array — the `ALL /<name>/*` proxy
 * route, the `modules` list in `GET /`, the OpenAPI merge in `GET /openapi.json` and the `Env`
 * binding type itself — so exposing a new internal Worker is one entry here plus its service
 * binding in `wrangler.jsonc`, with no new code in `src/index.ts`.
 */

/** How the caller's request is handed to a module over its service binding. */
type ForwardingPolicy = {
  /**
   * When set, only these headers cross the binding and everything else the caller sent is dropped.
   * Omit it to forward the caller's Request as it stands — headers, body and all — which is what a
   * module needs when it reads `CF-Connecting-IP`/`User-Agent` for an audit trail or validates the
   * `Authorization` header itself.
   */
  forwardHeaders?: readonly string[]
  /**
   * Redirect mode pinned on the forwarded Request. Only needed where a 3xx must reach the browser
   * instead of being followed inside the Worker.
   */
  redirect?: RequestInit['redirect']
  /**
   * Set when the module answers cross-origin requests itself, which makes the gateway leave its
   * CORS headers alone. Only worth it for a module whose set of allowed origins is not knowable
   * here — `auth` is the case: its clients live on their own domains and are registered in its
   * database, so the gateway's fixed allowlist cannot describe them.
   */
  ownsCors?: boolean
}

/** An internal Worker mounted under `/<name>/*` and merged into the combined OpenAPI document. */
type ServiceModule = ForwardingPolicy & {
  /** Path segment the module is mounted on, and the prefix stripped before forwarding. */
  name: string
  /** Cloudflare service binding declared in `wrangler.jsonc` and typed in `src/env.ts`. */
  binding: string
  /** OpenAPI tag the proxy route is filed under. */
  tag: string
  /** OpenAPI description of the proxy route. */
  description: string
}

const SERVICE_MODULES = [
  {
    name: 'landing',
    binding: 'LANDING',
    tag: 'Landing',
    description: 'Proxy to the landing site Worker (franciscosolis.cl)',
    // The landing module reads nothing else off the request, so the rest of the caller's headers
    // (cookies, user agent, client IP) never leave the gateway.
    forwardHeaders: ['Content-Type', 'Authorization'],
  },
  {
    name: 'auth',
    binding: 'AUTH',
    tag: 'Auth',
    description: 'Proxy to the centralized authentication Worker',
    // The whole Request is forwarded instead of rebuilding a couple of headers: the auth module
    // needs CF-Connecting-IP and User-Agent for its audit trail, and the body for its POSTs.
    // `redirect: 'manual'` keeps the 302 that carries an authorization code from being followed
    // inside the Worker instead of reaching the browser.
    redirect: 'manual',
    // Sign-in happens from whatever domain a registered client application lives on, which this
    // gateway cannot enumerate. The auth Worker answers CORS from its own list of clients instead.
    ownsCors: true,
  },
  {
    name: 'cms',
    binding: 'CMS',
    tag: 'CMS',
    description: 'Proxy to the CMS Worker (landing page content, legal pages and outgoing email)',
    // Forwards the whole Request for the same reasons as auth, minus the redirect pinning: the CMS
    // needs the body of POST/PATCH calls, the Authorization header to validate the access token,
    // and CF-Connecting-IP for its audit trail.
  },
] as const satisfies readonly ServiceModule[]

/** A registry entry as written above, with its `binding` and `name` narrowed to the literals used. */
type RegisteredModule = (typeof SERVICE_MODULES)[number]

/** Binding names declared by the registry, so `Env` cannot drift out of sync with it. */
type ServiceBinding = RegisteredModule['binding']

/** Module names, in registry order — the `modules` list `GET /` advertises. */
const SERVICE_MODULE_NAMES = SERVICE_MODULES.map(({ name }) => name)

/** Path prefixes the gateway's own CORS middleware must not touch. */
const CORS_DELEGATED_PREFIXES = SERVICE_MODULES.filter((module) => 'ownsCors' in module && module.ownsCors).map(
  ({ name }) => `/${name}/`,
)

export { CORS_DELEGATED_PREFIXES, SERVICE_MODULES, SERVICE_MODULE_NAMES }
export type { RegisteredModule, ServiceBinding, ServiceModule }
