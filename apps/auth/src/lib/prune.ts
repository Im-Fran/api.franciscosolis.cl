/**
 * The rules behind `POST /me/sessions/prune`: "close everything that is not this".
 *
 * Signing out of a long list of devices one row at a time is the kind of chore nobody finishes, so
 * the account screen offers a bulk close instead. Everything here is decided *relative to the
 * session making the request* — it is the only session the account holder is demonstrably holding
 * right now, so it is the one thing that can stand for "known" without asking them to enumerate
 * their own countries, networks and devices first.
 *
 * Three properties are deliberate:
 *
 * - **The current session is never a candidate.** A bulk action that can sign you out of the browser
 *   you are clicking in is a bulk action nobody dares press. Signing out here stays the separate,
 *   explicit button it already was.
 * - **Unknown is never a match.** A session with no location, no IP or no user agent — every row
 *   written before those columns existed, and every request the edge could not place — is left
 *   alone by the rule that reads that field. The alternative silently mass-revokes history the
 *   moment the feature ships.
 * - **A run with no rule selected matches nothing.** The route turns that into a 400 rather than
 *   letting an empty body mean "revoke everything".
 *
 * This module is pure: it decides, it does not write. The route applies the outcome.
 */

/** The session fields the rules read. Structural, so both a Drizzle row and a test fixture fit. */
type PrunableSession = {
  id: string
  applicationId: string
  provider: string
  ip: string | null
  userAgent: string | null
  country: string | null
  city: string | null
  lastSeenAt: Date
  createdAt: Date
  revokedAt: Date | null
}

/**
 * The conditions a user can tick. Each one is independent; `match` says whether a session has to
 * satisfy any of them (the default, "close anything that looks off") or all of them at once
 * ("close what is both old *and* from somewhere else").
 */
type PruneRules = {
  /** Not seen for at least this many days. Measured on `lastSeenAt`, so it means "idle". */
  inactiveForDays?: number
  /** Opened more than this many days ago, however active it has been since. */
  olderThanDays?: number
  /** Signed in from a country other than the current session's. */
  otherCountries?: boolean
  /** Signed in from an IP outside the current session's network (IPv4 /24, IPv6 /48). */
  otherNetworks?: boolean
  /** Opened from a different browser or device than the one asking. */
  otherDevices?: boolean
}

/** Filters that narrow *which* sessions the rules are even considered against. Always ANDed. */
type PruneScope = {
  /** Only sessions of these applications. Empty or absent means every application. */
  applications?: string[]
  /** Only sessions opened through these providers. Empty or absent means every provider. */
  providers?: string[]
}

type PruneInput<T extends PrunableSession> = {
  sessions: T[]
  current: PrunableSession
  rules: PruneRules
  scope?: PruneScope
  match?: 'any' | 'all'
  /** Injected so a test does not have to move the clock. */
  now?: Date
}

const DAY = 24 * 60 * 60 * 1000

/**
 * The part of an address that identifies a network rather than a machine.
 *
 * A phone on mobile data gets a different address on every reconnection, so comparing full
 * addresses would flag the user's own devices constantly. /24 for IPv4 and /48 for IPv6 are the
 * coarse-but-honest boundaries: an ISP hands out addresses inside them, and a session from another
 * ISP or another country falls outside.
 *
 * Returns null for anything that does not parse, which makes the rule skip that session entirely.
 */
const networkOf = (ip: string | null): string | null => {
  if (!ip) return null
  const address = ip.trim().toLowerCase()
  if (!address) return null

  if (address.includes('.') && !address.includes(':')) {
    const octets = address.split('.')
    if (octets.length !== 4) return null
    if (!octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)) return null
    return octets.slice(0, 3).join('.')
  }

  if (address.includes(':')) {
    // `::` expands to as many zero groups as the address is missing; expanding it is what makes
    // `2001:db8::1` and `2001:0db8:0000:0000:0000:0000:0000:1` compare equal.
    const [head, tail, ...rest] = address.split('::')
    if (rest.length > 0) return null

    const parts = (groups: string | undefined) => (groups ? groups.split(':').filter(Boolean) : [])
    const left = parts(head)
    const right = parts(tail)
    const groups =
      address.includes('::') ?
        [...left, ...Array.from({ length: Math.max(0, 8 - left.length - right.length) }, () => '0'), ...right]
      : left

    if (groups.length !== 8) return null
    if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null
    return groups
      .slice(0, 3)
      .map((group) => group.replace(/^0+(?=.)/, ''))
      .join(':')
  }

  return null
}

/**
 * A coarse identity for a client, so the same browser upgrading its version is still "this device".
 * Everything but the browser and platform families is dropped, because the version numbers in a
 * user agent change on their own and would otherwise read as a new device every few weeks.
 */
const deviceOf = (userAgent: string | null): string | null => {
  if (!userAgent) return null

  const platform =
    /windows/i.test(userAgent) ? 'windows'
    : /iphone|ipad|ipod/i.test(userAgent) ? 'ios'
    : /android/i.test(userAgent) ? 'android'
    : /mac os x|macintosh/i.test(userAgent) ? 'macos'
    : /cros/i.test(userAgent) ? 'chromeos'
    : /linux/i.test(userAgent) ? 'linux'
    : null

  const browser =
    /edg\//i.test(userAgent) ? 'edge'
    : /opr\/|opera/i.test(userAgent) ? 'opera'
    : /firefox\//i.test(userAgent) ? 'firefox'
    : /chrome\//i.test(userAgent) ? 'chrome'
    : /safari\//i.test(userAgent) ? 'safari'
    : null

  // Neither family recognised: fall back to the raw string, so two genuinely different odd clients
  // still compare as different rather than both collapsing to "unknown".
  if (!browser && !platform) return userAgent.trim().toLowerCase() || null
  return `${browser ?? '?'}/${platform ?? '?'}`
}

/** Whether any rule at all was asked for. An empty set matches nothing, by design. */
const hasRules = (rules: PruneRules) =>
  rules.inactiveForDays !== undefined ||
  rules.olderThanDays !== undefined ||
  Boolean(rules.otherCountries) ||
  Boolean(rules.otherNetworks) ||
  Boolean(rules.otherDevices)

/**
 * Evaluates one session against the rules.
 *
 * Every rule answers a tri-state: true (matches), false (does not), or null ("cannot tell", because
 * the session or the current one lacks the field). A null is dropped from the decision rather than
 * counted either way — under `any` it cannot push a session in, and under `all` it does not push
 * one out. A session where *no* rule could be evaluated is never a match.
 */
const evaluateSession = (
  session: PrunableSession,
  current: PrunableSession,
  rules: PruneRules,
  match: 'any' | 'all',
  now: Date,
): boolean => {
  const verdicts: (boolean | null)[] = []

  if (rules.inactiveForDays !== undefined) {
    verdicts.push(now.getTime() - session.lastSeenAt.getTime() >= rules.inactiveForDays * DAY)
  }
  if (rules.olderThanDays !== undefined) {
    verdicts.push(now.getTime() - session.createdAt.getTime() >= rules.olderThanDays * DAY)
  }
  if (rules.otherCountries) {
    verdicts.push(session.country && current.country ? session.country !== current.country : null)
  }
  if (rules.otherNetworks) {
    const here = networkOf(current.ip)
    const there = networkOf(session.ip)
    verdicts.push(here && there ? here !== there : null)
  }
  if (rules.otherDevices) {
    const here = deviceOf(current.userAgent)
    const there = deviceOf(session.userAgent)
    verdicts.push(here && there ? here !== there : null)
  }

  const decided = verdicts.filter((verdict): verdict is boolean => verdict !== null)
  if (decided.length === 0) return false
  return match === 'all' ? decided.every(Boolean) : decided.some(Boolean)
}

/** Whether a session is in scope at all, before any rule is considered. */
const inScope = (session: PrunableSession, scope: PruneScope | undefined) => {
  if (scope?.applications?.length && !scope.applications.includes(session.applicationId)) return false
  if (scope?.providers?.length && !scope.providers.includes(session.provider)) return false
  return true
}

/**
 * The sessions a prune run would close, in the order they were given.
 *
 * Already-revoked sessions and the current one are dropped before anything is evaluated, so a
 * caller can hand this the account's whole list without pre-filtering it.
 */
const selectSessionsToPrune = <T extends PrunableSession>({
  sessions,
  current,
  rules,
  scope,
  match = 'any',
  now = new Date(),
}: PruneInput<T>): T[] => {
  if (!hasRules(rules)) return []

  return sessions.filter(
    (session) =>
      !session.revokedAt &&
      session.id !== current.id &&
      inScope(session, scope) &&
      evaluateSession(session, current, rules, match, now),
  )
}

export { deviceOf, hasRules, networkOf, selectSessionsToPrune }
export type { PrunableSession, PruneRules, PruneScope }
