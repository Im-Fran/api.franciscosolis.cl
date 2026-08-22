/**
 * Matching of a browser `Origin` header against what a client application registered.
 *
 * A registered entry is normally a literal origin and is compared as one. The one exception is a
 * leading `*.` label, which stands for "any subdomain of this host":
 *
 *     https://*.franciscosolis.workers.dev
 *
 * That shape exists for one reason — Cloudflare preview deployments. A Worker deployed from a
 * branch or a version is served at `<alias>-<worker>.<account>.workers.dev`, a hostname that only
 * exists once the deployment happens and changes with the branch, so it can never be registered in
 * advance. Without a pattern, a preview build of a front-end cannot make a single cross-origin call
 * to this Worker, which makes previews useless for anything behind sign-in.
 *
 * The wildcard is narrow on purpose:
 *
 * - It only ever replaces the leftmost labels of the host, never the scheme, the port or anything
 *   to the right of the anchor, and the anchor is matched on a dot boundary — so
 *   `evil-franciscosolis.workers.dev`, a hostname anyone can take, is not a subdomain of
 *   `franciscosolis.workers.dev` and does not match.
 * - It must leave at least two labels below the wildcard, so a registration can never read
 *   `https://*.dev` and open the entire TLD. That is a floor, not a guarantee: `*.workers.dev`
 *   passes it and would trust every Cloudflare account, so the judgement of what a wildcard is
 *   anchored on stays with whoever registers the client — the same trust that registering the
 *   client already implies.
 * - It applies to CORS only. Redirect URIs are still matched byte for byte (`resolveClient` in
 *   `services/applications.ts`), because that is where an authorization code would be handed to
 *   whoever controls the host, and OAuth 2.0 Security BCP is unambiguous about it.
 */

/** Marks a registered entry as a pattern, and is the only wildcard syntax understood. */
const WILDCARD_PREFIX = '*.'

/** Labels a wildcard must leave standing below it, so no pattern can be anchored on a bare TLD. */
const MIN_ANCHOR_LABELS = 2

/** Splits `scheme://authority`, which `URL` cannot do for a pattern: `*` is not a hostname. */
const splitOrigin = (value: string) => {
  const separator = value.indexOf('://')
  if (separator === -1) {
    return null
  }
  return {
    scheme: value.slice(0, separator).toLowerCase(),
    authority: value.slice(separator + '://'.length).toLowerCase(),
  }
}

/** Is this entry a wildcard pattern, as opposed to a literal origin? */
const isOriginPattern = (value: string): boolean => splitOrigin(value)?.authority.startsWith(WILDCARD_PREFIX) === true

/** The host a pattern is anchored on, or null when the entry is not a usable pattern. */
const patternAnchor = (pattern: string): string | null => {
  const parsed = splitOrigin(pattern)
  if (!parsed?.authority.startsWith(WILDCARD_PREFIX)) {
    return null
  }
  const anchor = parsed.authority.slice(WILDCARD_PREFIX.length)
  if (anchor.split('.').filter(Boolean).length < MIN_ANCHOR_LABELS) {
    return null
  }
  // The anchor has to be an authority and nothing else. A path or userinfo left inside it would be
  // compared with `endsWith` against a whole `Origin`, which is how `https://*.example.com/x` would
  // end up matching `https://evil.test/a.example.com/x`.
  const authority = `${parsed.scheme}://${anchor}`
  try {
    if (new URL(authority).origin !== authority) {
      return null
    }
  } catch {
    return null
  }
  return anchor
}

/** Is `value` a registration this Worker can act on — a canonical origin, or a valid pattern? */
const isRegisterableOrigin = (value: string): boolean => {
  if (isOriginPattern(value)) {
    return patternAnchor(value) !== null
  }
  try {
    return new URL(value).origin === value
  } catch {
    return false
  }
}

/** Does the `Origin` a browser sent fall under one registered entry? */
const matchesOrigin = (origin: string, entry: string): boolean => {
  // A pattern is only ever matched as one. Falling through to string equality would let the literal
  // text `https://*.example.com`, sent as an Origin header, match the entry that describes it.
  if (!isOriginPattern(entry)) {
    return origin === entry
  }

  const anchor = patternAnchor(entry)
  if (anchor === null) {
    return false
  }

  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  // An `Origin` is a scheme and an authority and nothing else. Without this, a header of
  // `https://evil.test/x.franciscosolis.workers.dev` would end with the anchor and be let through.
  if (url.origin !== origin) {
    return false
  }
  if (url.protocol !== `${splitOrigin(entry)?.scheme}:`) {
    return false
  }
  // `*` is pattern syntax, never a hostname: an `Origin` header spelling out the pattern itself
  // must not be read as one of the hosts it stands for.
  if (url.hostname.includes('*')) {
    return false
  }
  // `host`, not `hostname`, so a non-default port has to be part of the anchor to be accepted.
  return url.host.endsWith(`.${anchor}`)
}

/** Does the `Origin` a browser sent fall under any of the registered entries? */
const isOriginAllowed = (origin: string, entries: Iterable<string>): boolean => {
  for (const entry of entries) {
    if (matchesOrigin(origin, entry)) {
      return true
    }
  }
  return false
}

export { isOriginAllowed, isOriginPattern, isRegisterableOrigin, matchesOrigin, WILDCARD_PREFIX }
