import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { Database } from '@/db/client'
import type { AppEnv } from '@/env'
import { PAGINATION, PUBLIC_CACHE_SECONDS } from '@/lib/config'
import { DEFAULT_LOCALE, LOCALES } from '@/lib/locales'
import type { Application } from '@/services/applications'
import { findApplicationBySlug, listApplications, toPublicApplication, toPublicApplicationSummary } from '@/services/applications'
import { findUpdateByVersion, listUpdates, toPublicUpdate } from '@/services/updates'
import { buildWikiTree, findWikiPageBySlug, listWikiPages, toPublicWikiPage } from '@/services/wiki'

/**
 * Public read API for the standalone application pages. No authentication: this is what
 * franciscosolis.cl calls to render `/application/<slug>`, so it only ever exposes `published`
 * rows — a draft is invisible here regardless of what is asked for, and a draft application hides
 * its updates and its wiki along with it.
 *
 * Every read takes an optional `?locale`. It is a query parameter rather than `Accept-Language` on
 * purpose: these responses are cached publicly, and a language chosen by a header is a language a
 * shared cache has to be told to vary on — one missing `Vary` and the wrong country gets the wrong
 * cached copy. In the URL it is part of the cache key by construction.
 */
const app = new Hono<AppEnv>()

/** Shared by every public read: which language the prose fields should come back in. */
const localeQuery = v.optional(v.picklist(LOCALES))

/**
 * Resolves the `:slug` path segment to a published application, 404-ing on anything else.
 *
 * A draft answers 404 rather than 403 for the same reason a draft entry does in the CMS: the
 * existence of an unannounced application is not public information, and a 403 confirms the slug.
 */
const requirePublishedApplication = async (db: Database, slug: string): Promise<Application> => {
  const application = await findApplicationBySlug(db, slug)
  if (!application || application.status !== 'published') {
    throw new HTTPException(404, { message: 'Application not found' })
  }
  return application
}

const applicationSchema = v.looseObject({
  id: v.string(),
  slug: v.string(),
  name: v.string(),
  tabs: v.array(v.string()),
})

const listResponseSchema = v.object({ code: v.literal(200), data: v.array(applicationSchema) })

const listQuerySchema = v.object({
  locale: localeQuery,
  featured: v.optional(v.picklist(['true', 'false'])),
  search: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(120))),
  limit: v.optional(
    v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(PAGINATION.maxLimit)),
  ),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
})

app.get(
  '/applications',
  describeRoute({
    description:
      'Published applications, in the order an editor arranged them. The two tab bodies are left out here — they are full Markdown documents, and the single-application read is where they live.',
    tags: ['Applications'],
    responses: {
      200: { description: 'Published applications', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
    },
  }),
  validator('query', listQuerySchema),
  async (c) => {
    const { locale = DEFAULT_LOCALE, featured, search, limit = PAGINATION.defaultLimit, offset = 0 } = c.req.valid('query')

    const rows = await listApplications(getDb(c.env), {
      status: 'published',
      featured: featured === undefined ? undefined : featured === 'true',
      search,
      limit,
      offset,
    })

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({ code: 200, data: rows.map((row) => toPublicApplicationSummary(row, locale)) })
  },
)

const applicationResponseSchema = v.object({ code: v.literal(200), data: applicationSchema })

app.get(
  '/applications/:slug',
  describeRoute({
    description:
      'One published application: the banner, the tab bar, the links, and the Markdown behind the Overview and Contact tabs. The Updates and Wiki tabs are lists, and have routes of their own.',
    tags: ['Applications'],
    responses: {
      200: { description: 'The application', content: { 'application/json': { schema: resolver(applicationResponseSchema) } } },
      404: { description: 'No published application with that slug' },
    },
  }),
  validator('query', v.object({ locale: localeQuery })),
  async (c) => {
    const { locale = DEFAULT_LOCALE } = c.req.valid('query')
    const application = await requirePublishedApplication(getDb(c.env), c.req.param('slug'))

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({ code: 200, data: toPublicApplication(application, locale) })
  },
)

const updateSchema = v.looseObject({ id: v.string(), version: v.string(), title: v.string() })
const updateListResponseSchema = v.object({ code: v.literal(200), data: v.array(updateSchema) })

app.get(
  '/applications/:slug/updates',
  describeRoute({
    description:
      'The application\'s Updates tab: published release notes, newest release first. Ordered by the date the version shipped rather than by when the entry was written, so back-dating a forgotten release puts it where it belongs instead of at the top.',
    tags: ['Applications'],
    responses: {
      200: { description: 'Published release notes', content: { 'application/json': { schema: resolver(updateListResponseSchema) } } },
      404: { description: 'No published application with that slug' },
    },
  }),
  validator(
    'query',
    v.object({
      locale: localeQuery,
      limit: v.optional(
        v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(PAGINATION.maxLimit)),
      ),
      offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
    }),
  ),
  async (c) => {
    const { locale = DEFAULT_LOCALE, limit = PAGINATION.defaultLimit, offset = 0 } = c.req.valid('query')
    const db = getDb(c.env)
    const application = await requirePublishedApplication(db, c.req.param('slug'))

    const rows = await listUpdates(db, { applicationId: application.id, status: 'published', limit, offset })

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({ code: 200, data: rows.map((row) => toPublicUpdate(row, locale)) })
  },
)

app.get(
  '/applications/:slug/updates/:version',
  describeRoute({
    description: 'One published release note, addressed by its version label inside the application.',
    tags: ['Applications'],
    responses: {
      200: { description: 'The release note', content: { 'application/json': { schema: resolver(v.object({ code: v.literal(200), data: updateSchema })) } } },
      404: { description: 'No published application, or no published release with that version' },
    },
  }),
  validator('query', v.object({ locale: localeQuery })),
  async (c) => {
    const { locale = DEFAULT_LOCALE } = c.req.valid('query')
    const db = getDb(c.env)
    const application = await requirePublishedApplication(db, c.req.param('slug'))

    const update = await findUpdateByVersion(db, application.id, c.req.param('version'))
    if (!update || update.status !== 'published') {
      throw new HTTPException(404, { message: 'Release not found' })
    }

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({ code: 200, data: toPublicUpdate(update, locale) })
  },
)

const wikiNodeSchema = v.looseObject({ id: v.string(), slug: v.string(), title: v.string() })
const wikiTreeResponseSchema = v.object({ code: v.literal(200), data: v.array(wikiNodeSchema) })

app.get(
  '/applications/:slug/wiki',
  describeRoute({
    description:
      'The wiki sidebar: every published page of the application as a tree, without bodies. A page whose section is still a draft is listed at the top level rather than dropped, so an unpublished heading never hides published documentation.',
    tags: ['Applications'],
    responses: {
      200: { description: 'The sidebar', content: { 'application/json': { schema: resolver(wikiTreeResponseSchema) } } },
      404: { description: 'No published application with that slug' },
    },
  }),
  validator('query', v.object({ locale: localeQuery })),
  async (c) => {
    const { locale = DEFAULT_LOCALE } = c.req.valid('query')
    const db = getDb(c.env)
    const application = await requirePublishedApplication(db, c.req.param('slug'))

    const pages = await listWikiPages(db, { applicationId: application.id, status: 'published' })

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({ code: 200, data: buildWikiTree(pages, locale) })
  },
)

app.get(
  '/applications/:slug/wiki/:page',
  describeRoute({
    description: 'One published wiki page with its Markdown body, addressed by its slug inside the application.',
    tags: ['Applications'],
    responses: {
      200: { description: 'The page', content: { 'application/json': { schema: resolver(v.object({ code: v.literal(200), data: wikiNodeSchema })) } } },
      404: { description: 'No published application, or no published page with that slug' },
    },
  }),
  validator('query', v.object({ locale: localeQuery })),
  async (c) => {
    const { locale = DEFAULT_LOCALE } = c.req.valid('query')
    const db = getDb(c.env)
    const application = await requirePublishedApplication(db, c.req.param('slug'))

    const page = await findWikiPageBySlug(db, application.id, c.req.param('page'))
    if (!page || page.status !== 'published') {
      throw new HTTPException(404, { message: 'Wiki page not found' })
    }

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({ code: 200, data: toPublicWikiPage(page, locale) })
  },
)

export default app
