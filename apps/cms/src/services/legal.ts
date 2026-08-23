import { eq } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { legalPages } from '@/db/schema'
import {
  availableLocales,
  DEFAULT_LOCALE,
  LEGAL_TRANSLATABLE_FIELDS,
  localize,
  parseTranslations,
  resolveLocale,
  type Locale,
} from '@/lib/locales'

type LegalPage = typeof legalPages.$inferSelect

/**
 * Shape returned by the public routes: the document as a visitor sees it, in one locale.
 *
 * A legal document is the one place where the fallback deserves a second thought — a visitor
 * reading Spanish and being served the English terms is not ideal. It is still better than the
 * alternative of 404-ing a page the footer links to, and `locale` in the response says plainly
 * which text was served, which is what lets the website label an untranslated document.
 */
const toPublicPage = (page: LegalPage, requested: Locale = DEFAULT_LOCALE) => {
  const translations = parseTranslations(page.translations)
  const locale = resolveLocale(translations, requested)

  return {
    id: page.id,
    slug: page.slug,
    ...localize(
      { title: page.title, summary: page.summary, body: page.body },
      translations,
      locale,
      LEGAL_TRANSLATABLE_FIELDS,
    ),
    locale,
    available_locales: availableLocales(translations),
    version: page.version,
    effective_at: page.effectiveAt?.toISOString() ?? null,
    published_at: page.publishedAt?.toISOString() ?? null,
    updated_at: page.updatedAt.toISOString(),
  }
}

/** Listing shape: everything except the body, which is far too long for an index. */
const toPublicSummary = ({ body: _body, ...rest }: ReturnType<typeof toPublicPage>) => rest

/** The editorial shape: the default-locale text, with the translation map an editor writes into. */
const toAdminPage = (page: LegalPage) => ({
  ...toPublicPage(page, DEFAULT_LOCALE),
  translations: parseTranslations(page.translations),
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
