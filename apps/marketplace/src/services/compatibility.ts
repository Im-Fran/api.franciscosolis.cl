import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { productReleaseCompatibility } from '@/db/schema'
import { type CompatibilityEntry, toPublicCompatibility } from '@/lib/compatibility'

type CompatibilityEntryRow = typeof productReleaseCompatibility.$inferSelect

/** Editor order, then kind and name, so two entries added in one sitting keep their places. */
const listOrder = [
  asc(productReleaseCompatibility.position),
  asc(productReleaseCompatibility.kind),
  asc(productReleaseCompatibility.name),
]

const listCompatibility = async (db: Database, releaseId: string): Promise<CompatibilityEntryRow[]> =>
  db
    .select()
    .from(productReleaseCompatibility)
    .where(eq(productReleaseCompatibility.releaseId, releaseId))
    .orderBy(...listOrder)

/**
 * The compatibility of several releases in one read, keyed by release.
 *
 * The overview sidebar and the release detail both want it, and the sidebar composes half a dozen
 * other reads already: one statement per release there would make the panel's cost grow with how
 * many lines a product publishes.
 */
const compatibilityFor = async (
  db: Database,
  releaseIds: string[],
): Promise<Map<string, CompatibilityEntry[]>> => {
  const byRelease = new Map<string, CompatibilityEntry[]>()
  if (releaseIds.length === 0) {
    return byRelease
  }

  const rows = await db
    .select()
    .from(productReleaseCompatibility)
    .where(inArray(productReleaseCompatibility.releaseId, releaseIds))
    .orderBy(...listOrder)

  for (const row of rows) {
    const entries = byRelease.get(row.releaseId) ?? []
    entries.push(toPublicCompatibility(row))
    byRelease.set(row.releaseId, entries)
  }
  return byRelease
}

/** One entry, scoped by its release — an id from another release must not be reachable through this one. */
const findCompatibilityEntry = async (
  db: Database,
  releaseId: string,
  id: string,
): Promise<CompatibilityEntryRow | null> => {
  const [row] = await db
    .select()
    .from(productReleaseCompatibility)
    .where(and(eq(productReleaseCompatibility.id, id), eq(productReleaseCompatibility.releaseId, releaseId)))
    .limit(1)
  return row ?? null
}

const countCompatibility = async (db: Database, releaseId: string): Promise<number> =>
  (await listCompatibility(db, releaseId)).length

export {
  compatibilityFor,
  countCompatibility,
  findCompatibilityEntry,
  listCompatibility,
  toPublicCompatibility,
}
export type { CompatibilityEntryRow }
