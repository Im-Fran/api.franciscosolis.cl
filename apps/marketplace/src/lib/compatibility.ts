import * as v from 'valibot'

/**
 * What one release runs on: the operating systems, runtimes, dependencies and hardware it needs.
 *
 * Two decisions are load-bearing here and neither is obvious.
 *
 * **It is per release, never per product.** A release is exactly where support is added and
 * dropped — an update that starts requiring macOS 15 and stops supporting 32-bit is the ordinary
 * case, and a product-level list could not express either. The product page's sidebar shows the
 * latest stable release's list; a version's own detail shows that version's.
 *
 * **`kind` and `name` are typed; `constraint` is free text.** The typing is what makes the list
 * groupable and filterable — "which releases still support Java 17" is the question the whole thing
 * exists to answer, and it is why this is a table where `links` is JSON on the row. The constraint
 * is deliberately *not* parsed, for exactly the reason a version label is not parsed: this Worker
 * fronts a Minecraft plugin and a mobile app equally well, and `>= 14.0`, `1.20–1.21`, `17+` and
 * `2026.1` are all somebody's real requirement. Comparing them would need a semver the versions are
 * not, and a comparison that is right nine times in ten is worse than none.
 */

const COMPATIBILITY_KINDS = [
  'os',
  'runtime',
  'platform',
  'dependency',
  'hardware',
  'architecture',
  'other',
] as const

type CompatibilityKind = (typeof COMPATIBILITY_KINDS)[number]

type KindDefinition = {
  name: string
  description: string
}

const COMPATIBILITY_KIND_INFO = {
  os: { name: 'Operating system', description: 'macOS, Windows, Linux, Android, iOS.' },
  runtime: { name: 'Runtime', description: 'Java, Node.js, .NET, Python — what has to be installed to run it.' },
  platform: { name: 'Platform', description: 'The host it plugs into: Paper, Spigot, Docker, a browser.' },
  dependency: { name: 'Dependency', description: 'Another piece of software this one needs alongside it.' },
  hardware: { name: 'Hardware', description: 'Memory, disk, a GPU — a physical requirement.' },
  architecture: { name: 'Architecture', description: 'arm64, x86_64 — which builds exist.' },
  other: { name: 'Other', description: 'The escape hatch. Use it rather than a kind that is nearly right.' },
} as const satisfies Record<CompatibilityKind, KindDefinition>

/** At most this many entries on one release. A requirements list nobody reads is not a requirement. */
const MAX_COMPATIBILITY_ENTRIES = 32

const isCompatibilityKind = (value: string): value is CompatibilityKind =>
  (COMPATIBILITY_KINDS as readonly string[]).includes(value)

/**
 * What an editor may send. `strictObject` for the reason `linkSchema` is strict: a misspelled
 * `constrain` must be a 422, not a requirement that silently says nothing.
 */
const compatibilitySchema = v.strictObject({
  kind: v.picklist(COMPATIBILITY_KINDS),
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  /** The API field is `constraint`; the column is `constraint_text`, because `CONSTRAINT` is reserved. */
  constraint: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(120)))),
  optional: v.optional(v.boolean()),
  position: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(9999))),
})

const compatibilityPatchSchema = v.partial(compatibilitySchema)

type CompatibilityInput = v.InferOutput<typeof compatibilitySchema>

/** One entry as every response serializes it. The reserved-word mapping happens here and nowhere else. */
type CompatibilityEntry = {
  id: string
  kind: CompatibilityKind
  name: string
  constraint: string | null
  optional: boolean
  position: number
}

type CompatibilityRow = {
  id: string
  kind: string
  name: string
  constraintText: string | null
  optional: boolean
  position: number
}

const toPublicCompatibility = (row: CompatibilityRow): CompatibilityEntry => ({
  id: row.id,
  // Lenient on read, like every other stored vocabulary here: a kind retired in a later version of
  // this Worker degrades to `other` rather than 500-ing the release it was left on.
  kind: isCompatibilityKind(row.kind) ? row.kind : 'other',
  name: row.name,
  constraint: row.constraintText,
  optional: row.optional,
  position: row.position,
})

export {
  COMPATIBILITY_KIND_INFO,
  COMPATIBILITY_KINDS,
  compatibilityPatchSchema,
  compatibilitySchema,
  isCompatibilityKind,
  MAX_COMPATIBILITY_ENTRIES,
  toPublicCompatibility,
}
export type { CompatibilityEntry, CompatibilityInput, CompatibilityKind, CompatibilityRow }
