import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { legalPages } from '@/db/schema'
import type { AppEnv } from '@/env'
import { PUBLIC_CACHE_SECONDS } from '@/lib/config'
import { DEFAULT_LOCALE, LOCALES } from '@/lib/locales'
import { findPageBySlug, toPublicPage, toPublicSummary } from '@/services/legal'

/**
 * Public read API for the landing site's legal pages (privacy policy, terms, cookies…). Same rule
 * as the content routes: only `published` pages exist as far as this API is concerned, and `?locale`
 * picks the language rather than `Accept-Language`, so it stays part of the public cache key.
 */
const app = new Hono<AppEnv>()

const localeQuery = v.object({ locale: v.optional(v.picklist(LOCALES)) })

const summarySchema = v.looseObject({
  id: v.string(),
  slug: v.string(),
  title: v.string(),
})

const listResponseSchema = v.object({
  code: v.literal(200),
  data: v.array(summarySchema),
})

app.get(
  '/legal',
  describeRoute({
    description:
      'Published legal pages, without their bodies. Enough to build a footer or a legal index; fetch a single page for the text itself. `locale` translates the titles and summaries.',
    tags: ['Legal'],
    responses: {
      200: {
        description: 'Published legal pages',
        content: { 'application/json': { schema: resolver(listResponseSchema) } },
      },
    },
  }),
  validator('query', localeQuery),
  async (c) => {
    const { locale = DEFAULT_LOCALE } = c.req.valid('query')
    const pages = await getDb(c.env)
      .select()
      .from(legalPages)
      .where(eq(legalPages.status, 'published'))
      .orderBy(asc(legalPages.title))

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({ code: 200, data: pages.map((page) => toPublicSummary(toPublicPage(page, locale))) })
  },
)

const pageResponseSchema = v.object({
  code: v.literal(200),
  data: v.looseObject({
    id: v.string(),
    slug: v.string(),
    title: v.string(),
    body: v.string(),
  }),
})

app.get(
  '/legal/:slug',
  describeRoute({
    description:
      'A single published legal page, body included. The body is Markdown; the website renders it. An untranslated page is served in the default locale rather than 404-ing, and `locale` in the response says which text came back.',
    tags: ['Legal'],
    responses: {
      200: {
        description: 'The legal page',
        content: { 'application/json': { schema: resolver(pageResponseSchema) } },
      },
      404: { description: 'No published page with that slug' },
    },
  }),
  validator('query', localeQuery),
  async (c) => {
    const { locale = DEFAULT_LOCALE } = c.req.valid('query')
    const page = await findPageBySlug(getDb(c.env), c.req.param('slug'))
    if (!page || page.status !== 'published') {
      throw new HTTPException(404, { message: 'Legal page not found' })
    }

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({ code: 200, data: toPublicPage(page, locale) })
  },
)

export default app
