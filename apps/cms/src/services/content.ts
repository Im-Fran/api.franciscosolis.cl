import { and, asc, desc, eq, like, or, type SQL } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { contentEntries } from '@/db/schema'
import type { CollectionName } from '@/lib/collections'
import type { ContentStatus } from '@/lib/config'

type ContentEntry = typeof contentEntries.$inferSelect

/**
 * Parses a JSON column back into a value, falling back instead of throwing. A malformed blob is a
 * bug worth fixing, but it must not make an entire listing 500 — a single bad row would take the
 * whole landing page down with it.
 */
const parseJson = <T>(raw: string | null, fallback: T): T => {
  if (!raw) {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Shape returned by the public routes and consumed by the website. */
const toPublicEntry = (entry: ContentEntry) => ({
  id: entry.id,
  collection: entry.collection,
  slug: entry.slug,
  title: entry.title,
  subtitle: entry.subtitle,
  summary: entry.summary,
  body: entry.body,
  featured: entry.featured,
  position: entry.position,
  started_at: entry.startedAt?.toISOString() ?? null,
  ended_at: entry.endedAt?.toISOString() ?? null,
  url: entry.url,
  image_url: entry.imageUrl,
  tags: parseJson<string[]>(entry.tags, []),
  data: parseJson<Record<string, unknown>>(entry.data, {}),
  published_at: entry.publishedAt?.toISOString() ?? null,
  updated_at: entry.updatedAt.toISOString(),
})

/** Same entry, plus the editorial fields only an authenticated editor may see. */
const toAdminEntry = (entry: ContentEntry) => ({
  ...toPublicEntry(entry),
  status: entry.status,
  created_by: entry.createdBy,
  updated_by: entry.updatedBy,
  created_at: entry.createdAt.toISOString(),
})

type ListFilters = {
  collection?: CollectionName
  status?: ContentStatus
  featured?: boolean
  /** Substring match against title, summary and slug. */
  search?: string
  /** Exact tag match. */
  tag?: string
  limit: number
  offset: number
}

/**
 * Ordering every listing shares: the manual `position` first so an editor can pin things, then most
 * recent by `started_at` (SQLite sorts NULLs last under DESC, which is what undated entries want),
 * then title for a stable tie-break.
 */
const listOrder = [asc(contentEntries.position), desc(contentEntries.startedAt), asc(contentEntries.title)]

const buildFilters = (filters: ListFilters): SQL | undefined => {
  const clauses: (SQL | undefined)[] = []

  if (filters.collection) {
    clauses.push(eq(contentEntries.collection, filters.collection))
  }
  if (filters.status) {
    clauses.push(eq(contentEntries.status, filters.status))
  }
  if (filters.featured !== undefined) {
    clauses.push(eq(contentEntries.featured, filters.featured))
  }
  if (filters.search) {
    const pattern = `%${filters.search.toLowerCase()}%`
    clauses.push(
      or(
        like(contentEntries.title, pattern),
        like(contentEntries.summary, pattern),
        like(contentEntries.slug, pattern),
      ),
    )
  }
  if (filters.tag) {
    // `tags` is a JSON array of strings, so the quoted form is matched to keep `go` from hitting
    // `golang`. Good enough for the handful of tags a personal site carries.
    clauses.push(like(contentEntries.tags, `%"${filters.tag.toLowerCase()}"%`))
  }

  const present = clauses.filter((clause): clause is SQL => clause !== undefined)
  return present.length > 0 ? and(...present) : undefined
}

const listEntries = async (db: Database, filters: ListFilters): Promise<ContentEntry[]> =>
  db
    .select()
    .from(contentEntries)
    .where(buildFilters(filters))
    .orderBy(...listOrder)
    .limit(filters.limit)
    .offset(filters.offset)

const findEntryById = async (db: Database, id: string): Promise<ContentEntry | null> => {
  const [entry] = await db.select().from(contentEntries).where(eq(contentEntries.id, id)).limit(1)
  return entry ?? null
}

const findEntryBySlug = async (
  db: Database,
  collection: CollectionName,
  slug: string,
): Promise<ContentEntry | null> => {
  const [entry] = await db
    .select()
    .from(contentEntries)
    .where(and(eq(contentEntries.collection, collection), eq(contentEntries.slug, slug)))
    .limit(1)
  return entry ?? null
}

export { findEntryById, findEntryBySlug, listEntries, parseJson, toAdminEntry, toPublicEntry }
export type { ContentEntry, ListFilters }
