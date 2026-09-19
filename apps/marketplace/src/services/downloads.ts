import { desc, eq } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { downloadEvents } from '@/db/schema'

type DownloadEvent = typeof downloadEvents.$inferSelect

type RecordDownloadInput = {
  fileId: string
  productId: string
  productSlug: string
  releaseId: string
  version: string
  filename: string
  userId: string | null
  purchaseId: string | null
  paid: boolean
  ip: string | null
  userAgent: string | null
}

/**
 * Logs a served download.
 *
 * Never throws, for the same reason `recordAudit` does not: the bytes are already on their way by the
 * time this runs, and losing the log entry must not turn a successful download into a 500. The log is
 * what "see your downloads" reads and what an editor's download count is reconciled against — it is
 * not a transactional guarantee.
 */
const recordDownload = async (db: Database, input: RecordDownloadInput) => {
  try {
    await db.insert(downloadEvents).values({
      id: crypto.randomUUID(),
      fileId: input.fileId,
      productId: input.productId,
      productSlug: input.productSlug,
      releaseId: input.releaseId,
      version: input.version,
      filename: input.filename,
      userId: input.userId,
      purchaseId: input.purchaseId,
      paid: input.paid,
      ip: input.ip,
      userAgent: input.userAgent,
    })
  } catch (error) {
    console.error('failed to record download', input.fileId, error)
  }
}

/** One download as the account that made it reads it back. The IP and user agent stay ours. */
const toPublicDownload = (event: DownloadEvent) => ({
  id: event.id,
  file_id: event.fileId,
  product_id: event.productId,
  product_slug: event.productSlug,
  version: event.version,
  filename: event.filename,
  paid: event.paid,
  purchase_id: event.purchaseId,
  created_at: event.createdAt.toISOString(),
})

/**
 * What one account downloaded, newest first.
 *
 * Only matched on the account id: unlike a purchase, a download is not something worth attributing
 * across accounts by address. An anonymous download has no account on it at all, by construction —
 * that is what makes a free build free.
 */
const listDownloadsForAccount = async (
  db: Database,
  userId: string,
  page: { limit: number; offset: number },
): Promise<DownloadEvent[]> =>
  db
    .select()
    .from(downloadEvents)
    .where(eq(downloadEvents.userId, userId))
    .orderBy(desc(downloadEvents.createdAt))
    .limit(page.limit)
    .offset(page.offset)

/** Every download of one product, for the editorial screen. Newest first. */
const listDownloadsForProduct = async (
  db: Database,
  productId: string,
  page: { limit: number; offset: number },
): Promise<DownloadEvent[]> =>
  db
    .select()
    .from(downloadEvents)
    .where(eq(downloadEvents.productId, productId))
    .orderBy(desc(downloadEvents.createdAt))
    .limit(page.limit)
    .offset(page.offset)

export { listDownloadsForAccount, listDownloadsForProduct, recordDownload, toPublicDownload }
export type { DownloadEvent, RecordDownloadInput }
