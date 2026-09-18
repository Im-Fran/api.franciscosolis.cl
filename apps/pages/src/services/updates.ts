import { and, asc, desc, eq, type SQL } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { applicationUpdates } from '@/db/schema'
import type { ContentStatus } from '@/lib/config'
import { parseLinks } from '@/lib/links'
import {
  availableLocales,
  DEFAULT_LOCALE,
  localize,
  parseTranslations,
  resolveLocale,
  UPDATE_TRANSLATABLE_FIELDS,
  type Locale,
} from '@/lib/locales'

type ApplicationUpdate = typeof applicationUpdates.$inferSelect

/** One release note as the Updates tab renders it, in one locale. */
const toPublicUpdate = (update: ApplicationUpdate, requested: Locale = DEFAULT_LOCALE) => {
  const translations = parseTranslations(update.translations)
  const locale = resolveLocale(translations, requested)

  return {
    id: update.id,
    application_id: update.applicationId,
    version: update.version,
    ...localize({ title: update.title, body: update.body }, translations, locale, UPDATE_TRANSLATABLE_FIELDS),
    locale,
    available_locales: availableLocales(translations),
    released_at: update.releasedAt?.toISOString() ?? null,
    links: parseLinks(update.links),
    published_at: update.publishedAt?.toISOString() ?? null,
    updated_at: update.updatedAt.toISOString(),
  }
}

const toAdminUpdate = (update: ApplicationUpdate) => ({
  ...toPublicUpdate(update, DEFAULT_LOCALE),
  translations: parseTranslations(update.translations),
  status: update.status,
  created_by: update.createdBy,
  updated_by: update.updatedBy,
  created_at: update.createdAt.toISOString(),
})

type UpdateFilters = {
  applicationId: string
  status?: ContentStatus
  limit: number
  offset: number
}

/**
 * Newest release first, which is what a changelog is.
 *
 * `releasedAt` and not `createdAt`: an editor writing up three versions in one sitting would
 * otherwise get them in the order they typed them, and back-dating an entry somebody forgot would
 * silently put it at the top. `createdAt` is the tie-break for two releases on the same day.
 */
const listOrder = [desc(applicationUpdates.releasedAt), desc(applicationUpdates.createdAt), asc(applicationUpdates.version)]

const buildFilters = (filters: UpdateFilters): SQL | undefined => {
  const clauses: SQL[] = [eq(applicationUpdates.applicationId, filters.applicationId)]
  if (filters.status) {
    clauses.push(eq(applicationUpdates.status, filters.status))
  }
  return and(...clauses)
}

const listUpdates = async (db: Database, filters: UpdateFilters): Promise<ApplicationUpdate[]> =>
  db
    .select()
    .from(applicationUpdates)
    .where(buildFilters(filters))
    .orderBy(...listOrder)
    .limit(filters.limit)
    .offset(filters.offset)

const findUpdateById = async (db: Database, id: string): Promise<ApplicationUpdate | null> => {
  const [update] = await db.select().from(applicationUpdates).where(eq(applicationUpdates.id, id)).limit(1)
  return update ?? null
}

/** A release note addressed the way the website addresses it: by version, inside one application. */
const findUpdateByVersion = async (
  db: Database,
  applicationId: string,
  version: string,
): Promise<ApplicationUpdate | null> => {
  const [update] = await db
    .select()
    .from(applicationUpdates)
    .where(and(eq(applicationUpdates.applicationId, applicationId), eq(applicationUpdates.version, version)))
    .limit(1)
  return update ?? null
}

export { findUpdateById, findUpdateByVersion, listUpdates, toAdminUpdate, toPublicUpdate }
export type { ApplicationUpdate, UpdateFilters }
