import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { legalPages } from '@/db/schema'
import type { AppEnv } from '@/env'
import { PUBLIC_CACHE_SECONDS } from '@/lib/config'
import { findPageBySlug, toPublicPage, toPublicSummary } from '@/services/legal'

/**
 * Public read API for the landing site's legal pages (privacy policy, terms, cookies…). Same rule
 * as the content routes: only `published` pages exist as far as this API is concerned.
 */
const app = new Hono<AppEnv>()

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
      'Published legal pages, without their bodies. Enough to build a footer or a legal index; fetch a single page for the text itself.',
    tags: ['Legal'],
    responses: {
      200: {
        description: 'Published legal pages',
        content: { 'application/json': { schema: resolver(listResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const pages = await getDb(c.env)
      .select()
      .from(legalPages)
      .where(eq(legalPages.status, 'published'))
      .orderBy(asc(legalPages.title))

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({ code: 200, data: pages.map((page) => toPublicSummary(toPublicPage(page))) })
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
    description: 'A single published legal page, body included. The body is Markdown; the website renders it.',
    tags: ['Legal'],
    responses: {
      200: {
        description: 'The legal page',
        content: { 'application/json': { schema: resolver(pageResponseSchema) } },
      },
      404: { description: 'No published page with that slug' },
    },
  }),
  async (c) => {
    const page = await findPageBySlug(getDb(c.env), c.req.param('slug'))
    if (!page || page.status !== 'published') {
      throw new HTTPException(404, { message: 'Legal page not found' })
    }

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({ code: 200, data: toPublicPage(page) })
  },
)

export default app
