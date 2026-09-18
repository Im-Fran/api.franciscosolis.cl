import { asc, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { helpArticles, helpCategories } from '@/db/schema'
import type { AppEnv } from '@/env'
import { ADMIN_PERMISSION, BODY_LIMITS, CONTENT_STATUS, PAGINATION } from '@/lib/config'
import { asConflict } from '@/lib/errors'
import { serializeTranslations } from '@/lib/locales'
import { slugify } from '@/lib/slug'
import {
  articleTranslations,
  categoryTranslations,
  optionalBody,
  optionalText,
  paginationSchema,
  requiredText,
} from '@/lib/validation'
import { requirePermission } from '@/middleware/auth'
import { getActorContext, getRequestContext, recordAudit } from '@/services/audit'
import { findArticleById, toAdminArticle, toAdminCategory } from '@/services/help'
import { reindexArticle, removeFromIndex } from '@/services/help-search'
import { reindexVectors, removeVectors } from '@/services/vectors'

const app = new Hono<AppEnv>()

// Everything in here reshapes the service rather than answering a ticket, so it sits behind the
// second-tier permission on top of the console gate `routes/admin/index.ts` already applied.
app.use('*', requirePermission(ADMIN_PERMISSION))

const articleSchema = v.looseObject({ id: v.string(), slug: v.string(), title: v.string() })
const categorySchema = v.looseObject({ id: v.string(), slug: v.string(), name: v.string() })
const listResponseSchema = v.object({ code: v.literal(200), data: v.array(v.looseObject({ id: v.string() })) })
const oneArticleSchema = v.object({ code: v.literal(200), data: articleSchema })
const oneCategorySchema = v.object({ code: v.literal(200), data: categorySchema })

/* ---------- categories ---------- */

app.get(
  '/help/categories',
  describeRoute({
    description: 'Every help-centre section, drafts included.',
    tags: ['Admin · Help'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Categories', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      403: { description: 'Missing the support:admin permission' },
    },
  }),
  async (c) => {
    const rows = await getDb(c.env)
      .select()
      .from(helpCategories)
      .orderBy(asc(helpCategories.position), asc(helpCategories.name))
    return c.json({ code: 200, data: rows.map(toAdminCategory) })
  },
)

const categoryBody = v.object({
  name: requiredText(120),
  slug: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(64))),
  description: optionalText(600),
  icon: optionalText(64),
  status: v.optional(v.picklist(CONTENT_STATUS)),
  position: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(9999))),
  translations: categoryTranslations,
})

app.post(
  '/help/categories',
  describeRoute({
    description: 'Creates a section.',
    tags: ['Admin · Help'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'Created', content: { 'application/json': { schema: resolver(oneCategorySchema) } } },
      409: { description: 'That slug is taken' },
      400: { description: 'The body failed validation' },
    },
  }),
  validator('json', categoryBody),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const agent = c.get('agent')
    const slug = slugify(body.slug || body.name)
    if (!slug) {
      throw new HTTPException(422, { message: 'No usable slug could be derived from that name' })
    }

    const row = {
      id: crypto.randomUUID(),
      slug,
      name: body.name,
      description: body.description ?? null,
      icon: body.icon ?? null,
      status: body.status ?? 'draft',
      position: body.position ?? 0,
      translations: serializeTranslations(body.translations),
      createdBy: agent.email,
      updatedBy: agent.email,
    }

    try {
      await db.insert(helpCategories).values(row)
    } catch (error) {
      throw asConflict(error, `A category with slug "${slug}" already exists`)
    }

    await recordAudit(db, {
      event: 'help.category.created',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'help_categories',
      resourceId: row.id,
      metadata: { slug },
    })

    const [created] = await db.select().from(helpCategories).where(eq(helpCategories.id, row.id)).limit(1)
    return c.json({ code: 201, data: toAdminCategory(created!) }, 201)
  },
)

app.patch(
  '/help/categories/:id',
  describeRoute({
    description: 'Updates a section. The slug is immutable — it is the address the website links to.',
    tags: ['Admin · Help'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Updated', content: { 'application/json': { schema: resolver(oneCategorySchema) } } },
      404: { description: 'No such category' },
      400: { description: 'The body failed validation' },
    },
  }),
  validator('json', v.partial(categoryBody)),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const [current] = await db.select().from(helpCategories).where(eq(helpCategories.id, c.req.param('id') ?? '')).limit(1)
    if (!current) {
      throw new HTTPException(404, { message: 'Category not found' })
    }

    await db
      .update(helpCategories)
      .set({
        name: body.name ?? current.name,
        description: body.description === undefined ? current.description : body.description,
        icon: body.icon === undefined ? current.icon : body.icon,
        status: body.status ?? current.status,
        position: body.position ?? current.position,
        translations: body.translations === undefined ? current.translations : serializeTranslations(body.translations),
        updatedBy: c.get('agent').email,
        updatedAt: new Date(),
      })
      .where(eq(helpCategories.id, current.id))

    await recordAudit(db, {
      event: 'help.category.updated',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'help_categories',
      resourceId: current.id,
      metadata: { slug: current.slug },
    })

    const [updated] = await db.select().from(helpCategories).where(eq(helpCategories.id, current.id)).limit(1)
    return c.json({ code: 200, data: toAdminCategory(updated!) })
  },
)

app.delete(
  '/help/categories/:id',
  describeRoute({
    description:
      'Deletes a section. Its articles survive and become uncategorised — deleting a section must not silently take its documentation with it.',
    tags: ['Admin · Help'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Deleted' },
      404: { description: 'No such category' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const [current] = await db.select().from(helpCategories).where(eq(helpCategories.id, c.req.param('id') ?? '')).limit(1)
    if (!current) {
      throw new HTTPException(404, { message: 'Category not found' })
    }

    // `help_articles.category_id` is ON DELETE SET NULL rather than CASCADE, which is what makes the
    // sentence above true.
    await db.delete(helpCategories).where(eq(helpCategories.id, current.id))
    await recordAudit(db, {
      event: 'help.category.deleted',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'help_categories',
      resourceId: current.id,
      metadata: { slug: current.slug },
    })

    return c.body(null, 204)
  },
)

/* ---------- articles ---------- */

app.get(
  '/help/articles',
  describeRoute({
    description: 'Every article, drafts included.',
    tags: ['Admin · Help'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Articles', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
    },
  }),
  validator('query', v.object({ status: v.optional(v.picklist(CONTENT_STATUS)), ...paginationSchema.entries })),
  async (c) => {
    const { status, limit = PAGINATION.defaultLimit, offset = 0 } = c.req.valid('query')
    const rows = await getDb(c.env)
      .select()
      .from(helpArticles)
      .where(status ? eq(helpArticles.status, status) : undefined)
      .orderBy(asc(helpArticles.position), desc(helpArticles.updatedAt))
      .limit(limit)
      .offset(offset)

    return c.json({ code: 200, data: rows.map(toAdminArticle) })
  },
)

const articleBody = v.object({
  title: requiredText(200),
  slug: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(64))),
  category_id: v.optional(v.nullable(v.string())),
  summary: optionalText(600),
  body: optionalBody(BODY_LIMITS.article),
  status: v.optional(v.picklist(CONTENT_STATUS)),
  position: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(9999))),
  featured: v.optional(v.boolean()),
  tags: v.optional(v.pipe(v.array(v.pipe(v.string(), v.trim(), v.maxLength(40))), v.maxLength(12))),
  translations: articleTranslations,
})

/**
 * Re-indexes an article everywhere it is searchable.
 *
 * FTS5 is awaited because the public search must never lag a publish by even a request — somebody
 * presses publish and immediately searches for what they just wrote. Vectorize is deferred, because
 * it costs an embedding call per chunk and an outage there must not fail an editor's save.
 */
const syncIndexes = async (
  db: ReturnType<typeof getDb>,
  env: AppEnv['Bindings'],
  waitUntil: (promise: Promise<unknown>) => void,
  articleId: string,
) => {
  const article = await findArticleById(db, articleId)
  if (!article) {
    return
  }
  await reindexArticle(db, article)
  waitUntil(
    reindexVectors(db, env, article).catch((error) => {
      console.error('failed to reindex vectors', articleId, error)
    }),
  )
}

app.post(
  '/help/articles',
  describeRoute({
    description: 'Creates an article. Publishing it also puts it in the search index.',
    tags: ['Admin · Help'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'Created', content: { 'application/json': { schema: resolver(oneArticleSchema) } } },
      409: { description: 'That slug is taken' },
      400: { description: 'The body failed validation' },
    },
  }),
  validator('json', articleBody),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const agent = c.get('agent')
    const slug = slugify(body.slug || body.title)
    if (!slug) {
      throw new HTTPException(422, { message: 'No usable slug could be derived from that title' })
    }
    const status = body.status ?? 'draft'

    const row = {
      id: crypto.randomUUID(),
      slug,
      categoryId: body.category_id ?? null,
      title: body.title,
      summary: body.summary ?? null,
      body: body.body ?? null,
      status,
      position: body.position ?? 0,
      featured: body.featured ?? false,
      tags: JSON.stringify(body.tags ?? []),
      translations: serializeTranslations(body.translations),
      // Stamped once, the first time it goes live, and kept through later unpublish cycles: it
      // records when the thing was published, not when it was last toggled.
      publishedAt: status === 'published' ? new Date() : null,
      createdBy: agent.email,
      updatedBy: agent.email,
    }

    try {
      await db.insert(helpArticles).values(row)
    } catch (error) {
      throw asConflict(error, `An article with slug "${slug}" already exists`)
    }

    await syncIndexes(db, c.env, (promise) => c.executionCtx.waitUntil(promise), row.id)
    await recordAudit(db, {
      event: 'help.article.created',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'help_articles',
      resourceId: row.id,
      metadata: { slug, status },
    })

    const created = await findArticleById(db, row.id)
    return c.json({ code: 201, data: toAdminArticle(created!) }, 201)
  },
)

app.patch(
  '/help/articles/:id',
  describeRoute({
    description: 'Updates an article and brings both search indexes back in step with it.',
    tags: ['Admin · Help'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Updated', content: { 'application/json': { schema: resolver(oneArticleSchema) } } },
      404: { description: 'No such article' },
      400: { description: 'The body failed validation' },
    },
  }),
  validator('json', v.partial(articleBody)),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const current = await findArticleById(db, c.req.param('id') ?? '')
    if (!current) {
      throw new HTTPException(404, { message: 'Article not found' })
    }

    const status = body.status ?? current.status
    await db
      .update(helpArticles)
      .set({
        title: body.title ?? current.title,
        categoryId: body.category_id === undefined ? current.categoryId : body.category_id,
        summary: body.summary === undefined ? current.summary : body.summary,
        body: body.body === undefined ? current.body : body.body,
        status,
        position: body.position ?? current.position,
        featured: body.featured ?? current.featured,
        tags: body.tags === undefined ? current.tags : JSON.stringify(body.tags),
        translations: body.translations === undefined ? current.translations : serializeTranslations(body.translations),
        publishedAt: status === 'published' ? (current.publishedAt ?? new Date()) : current.publishedAt,
        updatedBy: c.get('agent').email,
        updatedAt: new Date(),
      })
      .where(eq(helpArticles.id, current.id))

    await syncIndexes(db, c.env, (promise) => c.executionCtx.waitUntil(promise), current.id)
    await recordAudit(db, {
      event: 'help.article.updated',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'help_articles',
      resourceId: current.id,
      metadata: { slug: current.slug, status },
    })

    const updated = await findArticleById(db, current.id)
    return c.json({ code: 200, data: toAdminArticle(updated!) })
  },
)

app.delete(
  '/help/articles/:id',
  describeRoute({
    description: 'Deletes an article and removes it from both search indexes.',
    tags: ['Admin · Help'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Deleted' },
      404: { description: 'No such article' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const current = await findArticleById(db, c.req.param('id') ?? '')
    if (!current) {
      throw new HTTPException(404, { message: 'Article not found' })
    }

    await removeVectors(c.env, current)
    await db.delete(helpArticles).where(eq(helpArticles.id, current.id))
    // The migration's AFTER DELETE trigger covers this too; doing it here as well means the index is
    // clean whether the row left through this route or through a cascade.
    await removeFromIndex(db, current.id)

    await recordAudit(db, {
      event: 'help.article.deleted',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'help_articles',
      resourceId: current.id,
      metadata: { slug: current.slug },
    })

    return c.body(null, 204)
  },
)

app.post(
  '/help/articles/:id/reindex',
  describeRoute({
    description:
      'Rebuilds this article in both search indexes. For repairing drift after a Vectorize outage or an embedding-model change, which are the two ways they can fall behind.',
    tags: ['Admin · Help'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Reindexed' },
      404: { description: 'No such article' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const article = await findArticleById(db, c.req.param('id') ?? '')
    if (!article) {
      throw new HTTPException(404, { message: 'Article not found' })
    }

    const rows = await reindexArticle(db, article)
    // Awaited here, unlike on a save: this route exists precisely to be told whether it worked.
    const vectors = await reindexVectors(db, c.env, article)

    await recordAudit(db, {
      event: 'help.article.reindexed',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'help_articles',
      resourceId: article.id,
      metadata: { rows, vectors },
    })

    return c.json({ code: 200, data: { search_rows: rows, vectors } })
  },
)

export default app
