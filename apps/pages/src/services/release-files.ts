import { and, asc, eq, sql } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { applicationReleaseFiles } from '@/db/schema'
import type { ContentStatus } from '@/lib/config'

type ReleaseFile = typeof applicationReleaseFiles.$inferSelect

/**
 * One downloadable build as the Updates tab renders it.
 *
 * **`object_key` is not in here, and that is the point.** The bucket has no public access of its own,
 * and the only way to the bytes is `POST …/download` followed by `GET /downloads/:ticket` — so the key
 * never needs to leave this Worker, and a shape that cannot carry it is a shape no later change
 * accidentally leaks it through.
 *
 * `download_url` is deliberately absent too. A URL in a listing is a URL somebody bookmarks, and the
 * whole feature is that the link is minted per request, per person, with the payment state and the
 * cooldown baked into it.
 */
const toPublicReleaseFile = (file: ReleaseFile) => ({
  id: file.id,
  update_id: file.updateId,
  filename: file.filename,
  content_type: file.contentType,
  size: file.size,
  checksum: file.checksum,
  platform: file.platform,
  label: file.label,
  position: file.position,
  download_count: file.downloadCount,
  uploaded_at: file.uploadedAt?.toISOString() ?? null,
})

/** Same file, plus the editorial fields. Still without the object key: an editor has no use for it. */
const toAdminReleaseFile = (file: ReleaseFile) => ({
  ...toPublicReleaseFile(file),
  status: file.status,
  /** Whether the bytes are actually in the bucket. A row without them cannot be published. */
  has_content: file.uploadedAt !== null,
  created_by: file.createdBy,
  updated_by: file.updatedBy,
  created_at: file.createdAt.toISOString(),
  updated_at: file.updatedAt.toISOString(),
})

type ReleaseFileFilters = {
  updateId: string
  status?: ContentStatus
}

/** Editor order, then filename, so two builds added in one sitting do not swap places on a reload. */
const listOrder = [asc(applicationReleaseFiles.position), asc(applicationReleaseFiles.filename)]

const listReleaseFiles = async (db: Database, filters: ReleaseFileFilters): Promise<ReleaseFile[]> => {
  const clauses = [eq(applicationReleaseFiles.updateId, filters.updateId)]
  if (filters.status) {
    clauses.push(eq(applicationReleaseFiles.status, filters.status))
  }

  return db
    .select()
    .from(applicationReleaseFiles)
    .where(and(...clauses))
    .orderBy(...listOrder)
}

/** Every published file of an application, whatever release it hangs off. What a download path needs. */
const findReleaseFileById = async (db: Database, id: string): Promise<ReleaseFile | null> => {
  const [file] = await db.select().from(applicationReleaseFiles).where(eq(applicationReleaseFiles.id, id)).limit(1)
  return file ?? null
}

/**
 * Counts a served download on the row.
 *
 * `sql` increment rather than read-then-write: two people downloading at once would otherwise both
 * write the same number, and the counter is the one number an editor looks at on this screen.
 */
const countDownload = async (db: Database, id: string) => {
  await db
    .update(applicationReleaseFiles)
    .set({ downloadCount: sql`${applicationReleaseFiles.downloadCount} + 1` })
    .where(eq(applicationReleaseFiles.id, id))
}

export { countDownload, findReleaseFileById, listReleaseFiles, toAdminReleaseFile, toPublicReleaseFile }
export type { ReleaseFile, ReleaseFileFilters }
