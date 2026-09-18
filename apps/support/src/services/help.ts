import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { helpArticles, helpCategories, helpSearchQueries } from '@/db/schema'
import { HELP_SEARCH } from '@/lib/config'
import { parseJson } from '@/lib/json'
import {
  ARTICLE_TRANSLATABLE_FIELDS,
  availableLocales,
  CATEGORY_TRANSLATABLE_FIELDS,
  localize,
  parseTranslations,
  resolveLocale,
} from '@/lib/locales'
import type { Locale } from '@/lib/locales'

type ArticleRow = typeof helpArticles.$inferSelect
type CategoryRow = typeof helpCategories.$inferSelect

const toIso = (value: Date | null) => (value ? value.toISOString() : null)

/**
 * An article as the website reads it: resolved into one language, with `locale` saying which one it
 * actually got and `available_locales` for the switcher.
 *
 * The caller never has to guess whether it received the translation or the fallback, which is the
 * whole reason `resolveLocale` exists and why `?locale` is a query parameter rather than a header —
 * a public response is cacheable, and a header-chosen language needs a `Vary` somebody will forget.
 */
const toPublicArticle = (row: ArticleRow, requested: Locale) => {
  const translations = parseTranslations(row.translations)
  const locale = resolveLocale(translations, requested)
  const localized = localize(
    { title: row.title, summary: row.summary, body: row.body },
    translations,
    locale,
    ARTICLE_TRANSLATABLE_FIELDS,
  )

  return {
    slug: row.slug,
    category_id: row.categoryId,
    title: localized.title,
    summary: localized.summary,
    body: localized.body,
    tags: parseJson<string[]>(row.tags, []),
    featured: row.featured,
    helpful_yes: row.helpfulYes,
    helpful_no: row.helpfulNo,
    locale,
    available_locales: availableLocales(translations),
    published_at: toIso(row.publishedAt),
    updated_at: toIso(row.updatedAt),
  }
}

/** The listing form: enough for a card, without dragging a 200 KB body across for every row. */
const toArticleSummary = (row: ArticleRow, requested: Locale) => {
  const full = toPublicArticle(row, requested)
  const { body: _body, ...summary } = full
  return summary
}

/** The editorial form: always the default locale, with the raw override map beside it. */
const toAdminArticle = (row: ArticleRow) => ({
  id: row.id,
  slug: row.slug,
  category_id: row.categoryId,
  title: row.title,
  summary: row.summary,
  body: row.body,
  status: row.status,
  position: row.position,
  featured: row.featured,
  tags: parseJson<string[]>(row.tags, []),
  // The raw map, so an editor cannot save Spanish over the English row by accident.
  translations: parseTranslations(row.translations),
  helpful_yes: row.helpfulYes,
  helpful_no: row.helpfulNo,
  vector_ids: parseJson<string[]>(row.vectorIds, []),
  search_indexed_at: toIso(row.searchIndexedAt),
  published_at: toIso(row.publishedAt),
  created_at: toIso(row.createdAt),
  updated_at: toIso(row.updatedAt),
})

const toPublicCategory = (row: CategoryRow, requested: Locale) => {
  const translations = parseTranslations(row.translations)
  const locale = resolveLocale(translations, requested)
  const localized = localize(
    { name: row.name, description: row.description },
    translations,
    locale,
    CATEGORY_TRANSLATABLE_FIELDS,
  )

  return {
    slug: row.slug,
    name: localized.name,
    description: localized.description,
    icon: row.icon,
    locale,
    available_locales: availableLocales(translations),
  }
}

const toAdminCategory = (row: CategoryRow) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  description: row.description,
  icon: row.icon,
  status: row.status,
  position: row.position,
  translations: parseTranslations(row.translations),
  created_at: toIso(row.createdAt),
  updated_at: toIso(row.updatedAt),
})

const listPublishedCategories = (db: Database) =>
  db
    .select()
    .from(helpCategories)
    .where(eq(helpCategories.status, 'published'))
    .orderBy(asc(helpCategories.position), asc(helpCategories.name))

const listPublishedArticles = (
  db: Database,
  filters: { categoryId?: string; featured?: boolean; limit: number; offset: number },
) => {
  const conditions = [
    eq(helpArticles.status, 'published'),
    filters.categoryId ? eq(helpArticles.categoryId, filters.categoryId) : undefined,
    filters.featured ? eq(helpArticles.featured, true) : undefined,
  ].filter(Boolean)

  return db
    .select()
    .from(helpArticles)
    .where(and(...conditions))
    .orderBy(asc(helpArticles.position), desc(helpArticles.publishedAt))
    .limit(filters.limit)
    .offset(filters.offset)
}

const findArticleBySlug = async (db: Database, slug: string): Promise<ArticleRow | null> => {
  const [row] = await db.select().from(helpArticles).where(eq(helpArticles.slug, slug)).limit(1)
  return row ?? null
}

const findArticleById = async (db: Database, id: string): Promise<ArticleRow | null> => {
  const [row] = await db.select().from(helpArticles).where(eq(helpArticles.id, id)).limit(1)
  return row ?? null
}

const findArticlesByIds = (db: Database, ids: string[]) =>
  ids.length === 0 ? Promise.resolve([]) : db.select().from(helpArticles).where(inArray(helpArticles.id, ids))

const findCategoryBySlug = async (db: Database, slug: string): Promise<CategoryRow | null> => {
  const [row] = await db.select().from(helpCategories).where(eq(helpCategories.slug, slug)).limit(1)
  return row ?? null
}

/**
 * Records a search that found nothing useful.
 *
 * Only below the threshold, and that asymmetry is the point: one write per public search would be
 * indefensible amplification for a search box, while one write per *failed* search is the report of
 * what people are asking that nobody has written up yet — which is the only reason to log searches.
 */
const logSearch = async (db: Database, term: string, locale: Locale, resultCount: number) => {
  if (resultCount > HELP_SEARCH.logResultThreshold) {
    return
  }
  try {
    await db.insert(helpSearchQueries).values({
      id: crypto.randomUUID(),
      term: term.slice(0, 128),
      locale,
      resultCount,
    })
  } catch (error) {
    console.error('failed to log a help search', error)
  }
}

export {
  findArticleById,
  findArticleBySlug,
  findArticlesByIds,
  findCategoryBySlug,
  listPublishedArticles,
  listPublishedCategories,
  logSearch,
  toAdminArticle,
  toAdminCategory,
  toArticleSummary,
  toPublicArticle,
  toPublicCategory,
}
export type { ArticleRow, CategoryRow }
