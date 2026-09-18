import { and, asc, eq, type SQL } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { applicationWikiPages } from '@/db/schema'
import type { ContentStatus } from '@/lib/config'
import {
  availableLocales,
  DEFAULT_LOCALE,
  localize,
  parseTranslations,
  resolveLocale,
  WIKI_TRANSLATABLE_FIELDS,
  type Locale,
} from '@/lib/locales'

type WikiPage = typeof applicationWikiPages.$inferSelect

/**
 * A `parent_id` the sidebar could not be built from. Raised here and turned into a 422 by the
 * route, so the rule lives next to the tree it protects rather than in the handler.
 */
class WikiHierarchyError extends Error {}

/** One wiki page with its body — what the reading pane renders. */
const toPublicWikiPage = (page: WikiPage, requested: Locale = DEFAULT_LOCALE) => {
  const translations = parseTranslations(page.translations)
  const locale = resolveLocale(translations, requested)

  return {
    id: page.id,
    application_id: page.applicationId,
    parent_id: page.parentId,
    slug: page.slug,
    ...localize({ title: page.title, body: page.body }, translations, locale, WIKI_TRANSLATABLE_FIELDS),
    locale,
    available_locales: availableLocales(translations),
    icon: page.icon,
    position: page.position,
    published_at: page.publishedAt?.toISOString() ?? null,
    updated_at: page.updatedAt.toISOString(),
  }
}

const toAdminWikiPage = (page: WikiPage) => ({
  ...toPublicWikiPage(page, DEFAULT_LOCALE),
  translations: parseTranslations(page.translations),
  status: page.status,
  created_by: page.createdBy,
  updated_by: page.updatedBy,
  created_at: page.createdAt.toISOString(),
})

/** A sidebar entry: everything but the body, plus the pages nested under it. */
type WikiNode = Omit<ReturnType<typeof toPublicWikiPage>, 'body'> & { children: WikiNode[] }

/**
 * Builds the sidebar out of a flat list of pages.
 *
 * A page whose `parent_id` points at something not in the list is promoted to the top level rather
 * than dropped. That case is normal rather than exceptional on the public routes: a section left as
 * a draft takes its children out of the visible set, and losing those pages entirely would make an
 * unpublished heading hide published documentation. The tree is one level deep by rule
 * (`MAX_WIKI_DEPTH`), so a child never carries children of its own.
 */
const buildWikiTree = (pages: WikiPage[], requested: Locale = DEFAULT_LOCALE): WikiNode[] => {
  const nodes = new Map<string, WikiNode>()
  for (const page of pages) {
    const { body: _body, ...entry } = toPublicWikiPage(page, requested)
    nodes.set(page.id, { ...entry, children: [] })
  }

  const roots: WikiNode[] = []
  for (const page of pages) {
    const node = nodes.get(page.id)
    if (!node) {
      continue
    }
    const parent = page.parentId ? nodes.get(page.parentId) : undefined
    if (parent && parent.id !== node.id) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  return roots
}

/** How deep the sidebar may nest. A section and its pages; nothing under those. */
const MAX_WIKI_DEPTH = 2

/**
 * Validates the `parent_id` an editor sent and returns what should be stored.
 *
 * Four things are refused, and each of them is a shape the sidebar cannot render:
 * a parent in another application, a page as its own parent, a parent that is itself nested (which
 * would make the tree three deep), and nesting a page that already has children under it (same,
 * from the other end). Everything else — including moving a page back to the top level with an
 * explicit `null` — is allowed.
 *
 * `page` is the row being edited, or `null` when one is being created; a new page cannot yet have
 * children, so the last check is skipped for it.
 */
const resolveParentId = async (
  db: Database,
  applicationId: string,
  page: WikiPage | null,
  parentId: string | null,
): Promise<string | null> => {
  if (!parentId) {
    return null
  }

  if (page && parentId === page.id) {
    throw new WikiHierarchyError('A wiki page cannot be its own parent')
  }

  const parent = await findWikiPageById(db, parentId)
  if (!parent || parent.applicationId !== applicationId) {
    throw new WikiHierarchyError('The parent page does not belong to this application')
  }
  if (parent.parentId) {
    throw new WikiHierarchyError(
      `The wiki sidebar is only ${MAX_WIKI_DEPTH} levels deep, so a page that is itself nested cannot be a parent`,
    )
  }

  if (page) {
    const [child] = await db
      .select({ id: applicationWikiPages.id })
      .from(applicationWikiPages)
      .where(eq(applicationWikiPages.parentId, page.id))
      .limit(1)
    if (child) {
      throw new WikiHierarchyError('This page has pages under it, so it cannot be nested under another')
    }
  }

  return parent.id
}

type WikiFilters = {
  applicationId: string
  status?: ContentStatus
}

/** Manual order first — a wiki is a reading order, not an alphabet — then title as a tie-break. */
const listOrder = [asc(applicationWikiPages.position), asc(applicationWikiPages.title)]

const buildFilters = (filters: WikiFilters): SQL | undefined => {
  const clauses: SQL[] = [eq(applicationWikiPages.applicationId, filters.applicationId)]
  if (filters.status) {
    clauses.push(eq(applicationWikiPages.status, filters.status))
  }
  return and(...clauses)
}

const listWikiPages = async (db: Database, filters: WikiFilters): Promise<WikiPage[]> =>
  db
    .select()
    .from(applicationWikiPages)
    .where(buildFilters(filters))
    .orderBy(...listOrder)

const findWikiPageById = async (db: Database, id: string): Promise<WikiPage | null> => {
  const [page] = await db.select().from(applicationWikiPages).where(eq(applicationWikiPages.id, id)).limit(1)
  return page ?? null
}

const findWikiPageBySlug = async (db: Database, applicationId: string, slug: string): Promise<WikiPage | null> => {
  const [page] = await db
    .select()
    .from(applicationWikiPages)
    .where(and(eq(applicationWikiPages.applicationId, applicationId), eq(applicationWikiPages.slug, slug)))
    .limit(1)
  return page ?? null
}

export {
  buildWikiTree,
  findWikiPageById,
  findWikiPageBySlug,
  listWikiPages,
  MAX_WIKI_DEPTH,
  resolveParentId,
  toAdminWikiPage,
  toPublicWikiPage,
  WikiHierarchyError,
}
export type { WikiFilters, WikiNode, WikiPage }
