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
  /**
   * A path this gateway still answers on for compatibility, forwarding to a module that has been
   * renamed. It is proxied like any other entry and left out of everything that describes the
   * service: the `modules` list, and the combined OpenAPI document — which would otherwise carry
   * the same paths twice under two prefixes.
   *
   * The string is the reason it is still here, so that removing it is a decision somebody makes on
   * purpose rather than a tidy-up nobody questions.
   */
  deprecated?: string
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
  {
    name: 'marketplace',
    binding: 'MARKETPLACE',
    tag: 'Marketplace',
    description:
      'Proxy to the marketplace Worker (product pages, release channels, downloads, payments, reviews and analytics)',
    // Forwards the whole Request for the same reasons as the CMS, plus one of its own: a page view
    // is deduplicated per viewer on a hash of CF-Connecting-IP and User-Agent, so both have to
    // survive the hop or every view in the world would look like the same person.
  },
  {
    // The path `apps/pages` used to answer on, kept pointing at its replacement.
    //
    // This exists for one reason and it is worth one paragraph. MercadoPago bakes
    // `notification_url` into a Checkout Pro preference **when the preference is created**, not
    // when it is paid. A preference created five minutes before the cutover notifies `/pages/*`
    // after it, and without this entry that notification is a 404: the buyer pays, the webhook
    // never lands, and the only trace is a `pending` row. The gateway strips the prefix, so the
    // notification reaches `/payments/mercadopago/webhook` on the marketplace Worker exactly as a
    // fresh one would. `/downloads/:ticket` is the other path that survives usefully, for a ticket
    // in flight; the old content paths simply 404 there, which is correct.
    //
    // Remove it once no preference created before the cutover can still be paid.
    name: 'pages',
    binding: 'MARKETPLACE',
    tag: 'Marketplace',
    description: 'Deprecated alias of /marketplace/*, kept for MercadoPago preferences created before the rename',
    deprecated: 'MercadoPago preferences created before the marketplace rename still notify this path',
  },
  {
    name: 'support',
    binding: 'SUPPORT',
    tag: 'Support',
    description: 'Proxy to the support Worker (tickets, the help centre and the deferred-reply notifications)',
    // Forwards the whole Request for the same reasons as the CMS, plus one of its own: the public
    // ticket form is rate limited per client IP, so `CF-Connecting-IP` has to survive the hop or the
    // limit would count every request in the world as coming from one address.
  },
  {
    name: 'notifications',
    binding: 'NOTIFICATIONS',
    tag: 'Notifications',
    description:
      'Proxy to the notifications Worker (the in-site notification list, preferences, Web Push subscriptions and digests)',
    // Forwards the whole Request for the same reasons as the CMS: the body of a preference update or
    // a push subscription, and the `Authorization` header the module verifies itself. Its CORS is the
    // gateway's, not its own — every caller is the website, which is already on the allowlist, and
    // `PUT /me/preferences` and `DELETE` of a subscription are verbs the allowlist already carries.
    //
    // This is the only direction the two are wired in. The producers (`auth`, `support`,
    // `marketplace`) reach this Worker through a queue, not through a binding and not through here.
  },
] as const satisfies readonly ServiceModule[]

/** A registry entry as written above, with its `binding` and `name` narrowed to the literals used. */
type RegisteredModule = (typeof SERVICE_MODULES)[number]

/** Binding names declared by the registry, so `Env` cannot drift out of sync with it. */
type ServiceBinding = RegisteredModule['binding']

/** Module names, in registry order — the `modules` list `GET /` advertises. Aliases are not modules. */
const SERVICE_MODULE_NAMES = SERVICE_MODULES.filter((module) => !('deprecated' in module)).map(({ name }) => name)

/** Path prefixes the gateway's own CORS middleware must not touch. */
const CORS_DELEGATED_PREFIXES = SERVICE_MODULES.filter((module) => 'ownsCors' in module && module.ownsCors).map(
  ({ name }) => `/${name}/`,
)

export { CORS_DELEGATED_PREFIXES, SERVICE_MODULES, SERVICE_MODULE_NAMES }
export type { RegisteredModule, ServiceBinding, ServiceModule }
