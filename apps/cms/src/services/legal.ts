import { eq } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { legalPages } from '@/db/schema'

type LegalPage = typeof legalPages.$inferSelect

/** Shape returned by the public routes: the document as a visitor sees it. */
const toPublicPage = (page: LegalPage) => ({
  id: page.id,
  slug: page.slug,
  title: page.title,
  summary: page.summary,
  body: page.body,
  version: page.version,
  effective_at: page.effectiveAt?.toISOString() ?? null,
  published_at: page.publishedAt?.toISOString() ?? null,
  updated_at: page.updatedAt.toISOString(),
})

/** Listing shape: everything except the body, which is far too long for an index. */
const toPublicSummary = ({ body: _body, ...rest }: ReturnType<typeof toPublicPage>) => rest

const toAdminPage = (page: LegalPage) => ({
  ...toPublicPage(page),
  status: page.status,
  created_by: page.createdBy,
  updated_by: page.updatedBy,
  created_at: page.createdAt.toISOString(),
})

const findPageById = async (db: Database, id: string): Promise<LegalPage | null> => {
  const [page] = await db.select().from(legalPages).where(eq(legalPages.id, id)).limit(1)
  return page ?? null
}

const findPageBySlug = async (db: Database, slug: string): Promise<LegalPage | null> => {
  const [page] = await db.select().from(legalPages).where(eq(legalPages.slug, slug)).limit(1)
  return page ?? null
}

export { findPageById, findPageBySlug, toAdminPage, toPublicPage, toPublicSummary }
export type { LegalPage }
