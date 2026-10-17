/**
 * Semantic versions, as far as an updater needs them: parsing, and ordering per semver 2.0.0
 * (build metadata ignored; a pre-release sorts before its release).
 *
 * Lenient where a device would be: a leading `v` is accepted, and so are `1` and `1.4` (read as
 * `1.0.0` and `1.4.0`), because a version string comes from whatever the app was built with and an
 * update must still be offered to a device that reports `v1.4`.
 */

type SemVer = { major: number; minor: number; patch: number; prerelease: Array<string | number> }

const PATTERN = /^v?(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

const parseSemver = (value: string | null | undefined): SemVer | null => {
  const match = value ? PATTERN.exec(value.trim()) : null
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease: match[4] ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : [],
  }
}

const isSemver = (value: string) => parseSemver(value) !== null

/** Negative when `a` sorts before `b`, positive after, zero when equal. Unparseable sorts first. */
const compareSemver = (a: string | null | undefined, b: string | null | undefined): number => {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left || !right) return left ? 1 : right ? -1 : 0
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] - right[key]
  }
  // A version without a pre-release is greater than the same version with one.
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const x = left.prerelease[index]
    const y = right.prerelease[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

export { compareSemver, isSemver, parseSemver }
export type { SemVer }
