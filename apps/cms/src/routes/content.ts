import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { AppEnv } from '@/env'
import { COLLECTION_NAMES, COLLECTIONS, isCollection } from '@/lib/collections'
import { PAGINATION, PUBLIC_CACHE_SECONDS } from '@/lib/config'
import { DEFAULT_LOCALE, LOCALES } from '@/lib/locales'
import { findEntryBySlug, listEntries, toPublicEntry } from '@/services/content'

/**
 * Public read API for landing-page content. No authentication: this is what franciscosolis.cl
 * calls to render itself, so it only ever exposes `published` entries — a draft is invisible here
 * regardless of what is asked for.
 *
 * Every read takes an optional `?locale`. It is a query parameter rather than `Accept-Language`
 * on purpose: these responses are cached publicly, and a language chosen by a header is a language
 * a shared cache has to be told to vary on — one missing `Vary` and Chile gets Santiago's cached
 * English. In the URL it is part of the cache key by construction.
 */
const app = new Hono<AppEnv>()

const collectionsResponseSchema = v.object({
  code: v.literal(200),
  data: v.array(
    v.object({
      slug: v.string(),
      name: v.string(),
      description: v.string(),
    }),
  ),
})

app.get(
  '/collections',
  describeRoute({
    description:
      'Content collections this CMS manages. Useful for a CMS front-end to build its navigation without hardcoding the list.',
    tags: ['Content'],
    responses: {
      200: {
        description: 'Available collections',
        content: { 'application/json': { schema: resolver(collectionsResponseSchema) } },
      },
    },
  }),
  (c) => {
    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({
      code: 200,
      data: COLLECTION_NAMES.map((slug) => ({
        slug,
        name: COLLECTIONS[slug].name,
        description: COLLECTIONS[slug].description,
      })),
    })
  },
)

/** Shared by every public read: which language the prose fields should come back in. */
const localeQuery = v.optional(v.picklist(LOCALES))

const listQuerySchema = v.object({
  locale: localeQuery,
  featured: v.optional(v.picklist(['true', 'false'])),
  tag: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(60))),
  search: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(120))),
  limit: v.optional(
    v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(PAGINATION.maxLimit)),
  ),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
})

const entrySchema = v.looseObject({
  id: v.string(),
  collection: v.string(),
  slug: v.string(),
  title: v.string(),
})

const listResponseSchema = v.object({
  code: v.literal(200),
  data: v.array(entrySchema),
})

app.get(
  '/content/:collection',
  describeRoute({
    description:
      'Published entries of a collection, ordered by their manual position, then most recent first. Only `published` entries are returned. `locale` picks the language of the prose fields; untranslated fields fall back to the entry\'s own text and the response says which locale it was served in.',
    tags: ['Content'],
    responses: {
      200: {
        description: 'Published entries',
        content: { 'application/json': { schema: resolver(listResponseSchema) } },
      },
      404: { description: 'No such collection' },
    },
  }),
  validator('query', listQuerySchema),
  async (c) => {
    const collection = c.req.param('collection')
    if (!isCollection(collection)) {
      throw new HTTPException(404, { message: `Unknown collection: ${collection}` })
    }

    const {
      locale = DEFAULT_LOCALE,
      featured,
      tag,
      search,
      limit = PAGINATION.defaultLimit,
      offset = 0,
    } = c.req.valid('query')
    const entries = await listEntries(getDb(c.env), {
      collection,
      status: 'published',
      featured: featured === undefined ? undefined : featured === 'true',
      tag,
      search,
      limit,
      offset,
    })

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({ code: 200, data: entries.map((entry) => toPublicEntry(entry, locale)) })
  },
)

const entryResponseSchema = v.object({
  code: v.literal(200),
  data: entrySchema,
})

app.get(
  '/content/:collection/:slug',
  describeRoute({
    description:
      'A single published entry, addressed by its slug inside the collection. A draft or archived entry answers 404 here — its existence is not public information. Takes the same `locale` as the listing.',
    tags: ['Content'],
    responses: {
      200: {
        description: 'The entry',
        content: { 'application/json': { schema: resolver(entryResponseSchema) } },
      },
      404: { description: 'No such collection, or no published entry with that slug' },
    },
  }),
  validator('query', v.object({ locale: localeQuery })),
  async (c) => {
    const collection = c.req.param('collection')
    if (!isCollection(collection)) {
      throw new HTTPException(404, { message: `Unknown collection: ${collection}` })
    }

    const { locale = DEFAULT_LOCALE } = c.req.valid('query')
    const entry = await findEntryBySlug(getDb(c.env), collection, c.req.param('slug'))
    if (!entry || entry.status !== 'published') {
      throw new HTTPException(404, { message: 'Entry not found' })
    }

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({ code: 200, data: toPublicEntry(entry, locale) })
  },
)

export default app
