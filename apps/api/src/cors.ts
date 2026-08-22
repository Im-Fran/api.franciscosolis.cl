/**
 * The gateway's origin allowlist.
 *
 * Everything this API answers is read cross-origin by a browser, so the allowlist is the only thing
 * standing between a hostile page and a caller's data. It is deliberately hard-coded: the front-ends
 * that talk to this gateway are ours, and the one module whose clients live on domains we cannot
 * enumerate answers CORS for itself (`ownsCors` in `src/services.ts`).
 *
 * Two shapes are allowed, and nothing else:
 *
 * - Our own hosts and any subdomain of them, over HTTPS on the default port. The suffix is matched
 *   on a dot boundary rather than with a bare `endsWith`, because without the separator a domain an
 *   attacker can register — `evilfranciscosolis.cl`, `notfranciscosolis.workers.dev` — ends with the
 *   allowed string and would be handed an `Access-Control-Allow-Origin` naming itself.
 * - The Vite dev server, on its one port, over either scheme.
 *
 * `franciscosolis.workers.dev` is the account's own `workers.dev` subdomain, which is what makes it
 * safe to open to subdomains: Cloudflare hands out preview URLs under it as
 * `<alias>-<worker>.franciscosolis.workers.dev`, and only this account can deploy there. That is the
 * whole point — a Worker deployed from a branch gets a hostname nobody can know in advance, so it
 * has to be matched by pattern or previews can never call the API at all.
 */

/** Hosts whose subdomains are ours: matched exactly, or on a dot boundary below them. */
const ALLOWED_HOST_SUFFIXES = ['franciscosolis.cl', 'franciscosolis.workers.dev']

/** The Vite dev server, matched in full. Its scheme varies with whether a local cert is in use. */
const DEVELOPMENT_ORIGINS = ['http://localhost:5173', 'https://localhost:5173']

/**
 * What a browser is told when its origin is not on the list: an origin that is not its own, so the
 * check fails on its side. Answering with no header at all would work too, but a constant origin
 * keeps the response shape identical for every caller.
 */
const FALLBACK_ORIGIN = 'https://franciscosolis.cl'

const isAllowedOrigin = (origin: string): boolean => {
  if (DEVELOPMENT_ORIGINS.includes(origin)) {
    return true
  }

  let url: URL
  try {
    url = new URL(origin)
  } catch {
    // `null` — the origin of a sandboxed frame or a `data:` document — lands here, as does an
    // empty header.
    return false
  }

  // An `Origin` header is a scheme and an authority and nothing else. Anything that does not
  // round-trip through `URL` unchanged (a path, a trailing slash, credentials) is not one.
  if (url.origin !== origin) {
    return false
  }
  // HTTPS only, on the default port: our hosts serve nothing else, and a non-default port is
  // someone else's server on a hostname that happens to resolve to ours.
  if (url.protocol !== 'https:' || url.port !== '') {
    return false
  }

  return ALLOWED_HOST_SUFFIXES.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`))
}

/** The value of `Access-Control-Allow-Origin` for a caller, allowed or not. */
const resolveAllowedOrigin = (origin: string | undefined | null): string =>
  origin && isAllowedOrigin(origin) ? origin : FALLBACK_ORIGIN

export { ALLOWED_HOST_SUFFIXES, DEVELOPMENT_ORIGINS, FALLBACK_ORIGIN, isAllowedOrigin, resolveAllowedOrigin }
