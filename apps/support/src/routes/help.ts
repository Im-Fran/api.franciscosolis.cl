import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { helpArticleFeedback, helpArticles } from '@/db/schema'
import type { AppEnv } from '@/env'
import { HELP_SEARCH, PAGINATION, PUBLIC_CACHE_SECONDS } from '@/lib/config'
import { DEFAULT_LOCALE, LOCALES } from '@/lib/locales'
import { getRequestContext } from '@/services/audit'
import { sha256 } from '@/lib/tokens'
import {
  findArticleBySlug,
  findCategoryBySlug,
  listPublishedArticles,
  listPublishedCategories,
  logSearch,
  toArticleSummary,
  toPublicArticle,
  toPublicCategory,
} from '@/services/help'
import { searchArticles } from '@/services/help-search'

const app = new Hono<AppEnv>()

const localeQuery = v.object({ locale: v.optional(v.picklist(LOCALES)) })

const categorySchema = v.looseObject({ slug: v.string(), name: v.string() })
const articleSchema = v.looseObject({ slug: v.string(), title: v.string() })
const categoriesResponseSchema = v.object({ code: v.literal(200), data: v.array(categorySchema) })
const articlesResponseSchema = v.object({ code: v.literal(200), data: v.array(articleSchema) })
const articleResponseSchema = v.object({ code: v.literal(200), data: articleSchema })

/** Published help content is the only thing this Worker serves that a shared cache may keep. */
const cachePublicly = (c: { header: (name: string, value: string) => void }) => {
  c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
}

app.get(
  '/help/categories',
  describeRoute({
    description: 'Published help-centre sections, in display order. Takes `?locale`.',
    tags: ['Help'],
    responses: {
      200: { description: 'Categories', content: { 'application/json': { schema: resolver(categoriesResponseSchema) } } },
    },
  }),
  validator('query', localeQuery),
  async (c) => {
    const { locale = DEFAULT_LOCALE } = c.req.valid('query')
    const rows = await listPublishedCategories(getDb(c.env))
    cachePublicly(c)
    return c.json({ code: 200, data: rows.map((row) => toPublicCategory(row, locale)) })
  },
)

app.get(
  '/help/categories/:slug',
  describeRoute({
    description: 'One section and the published articles in it.',
    tags: ['Help'],
    responses: {
      200: { description: 'The category', content: { 'application/json': { schema: resolver(articleResponseSchema) } } },
      404: { description: 'No such published category' },
    },
  }),
  validator('query', localeQuery),
  async (c) => {
    const { locale = DEFAULT_LOCALE } = c.req.valid('query')
    const db = getDb(c.env)
    const category = await findCategoryBySlug(db, c.req.param('slug') ?? '')

    // A draft section answers exactly like a section that does not exist. There is nothing secret in
    // a help article, but a 403 would still confirm that one is being written.
    if (!category || category.status !== 'published') {
      throw new HTTPException(404, { message: 'Category not found' })
    }

    const articles = await listPublishedArticles(db, {
      categoryId: category.id,
      limit: PAGINATION.maxLimit,
      offset: 0,
    })

    cachePublicly(c)
    return c.json({
      code: 200,
      data: { ...toPublicCategory(category, locale), articles: articles.map((row) => toArticleSummary(row, locale)) },
    })
  },
)

const listQuerySchema = v.object({
  category: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(64))),
  featured: v.optional(v.picklist(['true', 'false'])),
  locale: v.optional(v.picklist(LOCALES)),
  limit: v.optional(v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(PAGINATION.maxLimit))),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
})

app.get(
  '/help/articles',
  describeRoute({
    description: 'Published articles, filterable by section and by whether they are pinned.',
    tags: ['Help'],
    responses: {
      200: { description: 'Articles', content: { 'application/json': { schema: resolver(articlesResponseSchema) } } },
    },
  }),
  validator('query', listQuerySchema),
  async (c) => {
    const query = c.req.valid('query')
    const locale = query.locale ?? DEFAULT_LOCALE
    const db = getDb(c.env)

    let categoryId: string | undefined
    if (query.category) {
      const category = await findCategoryBySlug(db, query.category)
      if (!category) {
        cachePublicly(c)
        return c.json({ code: 200, data: [] })
      }
      categoryId = category.id
    }

    const rows = await listPublishedArticles(db, {
      categoryId,
      featured: query.featured === 'true',
      limit: query.limit ?? PAGINATION.defaultLimit,
      offset: query.offset ?? 0,
    })

    cachePublicly(c)
    return c.json({ code: 200, data: rows.map((row) => toArticleSummary(row, locale)) })
  },
)

const searchQuerySchema = v.object({
  q: v.pipe(v.string(), v.trim(), v.maxLength(200)),
  locale: v.optional(v.picklist(LOCALES)),
  limit: v.optional(
    v.pipe(v.string(), v.regex(/^\d{1,2}$/), v.transform(Number), v.maxValue(HELP_SEARCH.maxLimit)),
  ),
})

app.get(
  '/help/search',
  describeRoute({
    description:
      'Full-text search over published articles. Results carry `<mark>` around the matched words — the only markup this API emits, and it must still be sanitised before it is rendered.',
    tags: ['Help'],
    responses: {
      200: { description: 'Matches', content: { 'application/json': { schema: resolver(articlesResponseSchema) } } },
      400: { description: 'The query failed validation' },
    },
  }),
  validator('query', searchQuerySchema),
  async (c) => {
    const { q, locale = DEFAULT_LOCALE, limit = HELP_SEARCH.defaultLimit } = c.req.valid('query')
    const db = getDb(c.env)

    let hits = await searchArticles(db, { query: q, locale, limit })
    let fallback = false

    // A Spanish speaker finding the English article beats finding nothing, so one retry against the
    // default locale — reported, so the front-end can say which language it ended up showing.
    if (hits.length === 0 && locale !== DEFAULT_LOCALE) {
      hits = await searchArticles(db, { query: q, locale: DEFAULT_LOCALE, limit })
      fallback = hits.length > 0
    }

    await logSearch(db, q, locale, hits.length)

    cachePublicly(c)
    return c.json({
      code: 200,
      data: hits.map((hit) => ({
        slug: hit.slug,
        title: hit.title,
        snippet: hit.snippet,
        locale: hit.locale,
        // bm25 is negative and smaller is better; flipped here so a client sorting descending by
        // `score` gets what it expects rather than the worst matches first.
        score: -hit.rank,
      })),
      meta: { fallback_locale: fallback },
    })
  },
)

app.get(
  '/help/articles/:slug',
  describeRoute({
    description: 'One published article, resolved into the requested language.',
    tags: ['Help'],
    responses: {
      200: { description: 'The article', content: { 'application/json': { schema: resolver(articleResponseSchema) } } },
      404: { description: 'No such published article' },
    },
  }),
  validator('query', localeQuery),
  async (c) => {
    const { locale = DEFAULT_LOCALE } = c.req.valid('query')
    const article = await findArticleBySlug(getDb(c.env), c.req.param('slug') ?? '')

    if (!article || article.status !== 'published') {
      throw new HTTPException(404, { message: 'Article not found' })
    }

    cachePublicly(c)
    return c.json({ code: 200, data: toPublicArticle(article, locale) })
  },
)

const feedbackSchema = v.object({
  helpful: v.boolean(),
  locale: v.optional(v.picklist(LOCALES)),
})

app.post(
  '/help/articles/:slug/feedback',
  describeRoute({
    description:
      'Records whether an article answered the question. Deduplicated per person per day, and deliberately the only counter on an article — a view counter would turn a cacheable read into a write.',
    tags: ['Help'],
    responses: {
      204: { description: 'Recorded, or already recorded today' },
      404: { description: 'No such published article' },
      400: { description: 'The body failed validation' },
    },
  }),
  validator('json', feedbackSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const article = await findArticleBySlug(db, c.req.param('slug') ?? '')

    if (!article || article.status !== 'published') {
      throw new HTTPException(404, { message: 'Article not found' })
    }

    const { ip, userAgent } = getRequestContext(c)
    // Coarse on purpose: this is a dedupe key, not an identifier. It changes every day and cannot be
    // used to follow somebody around.
    const fingerprintHash = await sha256(
      `${ip ?? 'unknown'}|${userAgent ?? 'unknown'}|${new Date().toISOString().slice(0, 10)}`,
    )

    const inserted = await db
      .insert(helpArticleFeedback)
      .values({
        id: crypto.randomUUID(),
        articleId: article.id,
        locale: body.locale ?? DEFAULT_LOCALE,
        helpful: body.helpful,
        fingerprintHash,
      })
      .onConflictDoNothing({ target: [helpArticleFeedback.articleId, helpArticleFeedback.fingerprintHash] })
      .returning({ id: helpArticleFeedback.id })

    if (inserted.length > 0) {
      await db
        .update(helpArticles)
        .set(
          body.helpful
            ? { helpfulYes: sql`${helpArticles.helpfulYes} + 1` }
            : { helpfulNo: sql`${helpArticles.helpfulNo} + 1` },
        )
        .where(eq(helpArticles.id, article.id))
    }

    return c.body(null, 204)
  },
)

export default app
