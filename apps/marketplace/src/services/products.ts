import { and, asc, desc, eq, like, or, type SQL } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { products } from '@/db/schema'
import type { ContentStatus } from '@/lib/config'
import { parseLinks } from '@/lib/links'
import {
  PRODUCT_TRANSLATABLE_FIELDS,
  availableLocales,
  DEFAULT_LOCALE,
  localize,
  parseTranslations,
  resolveLocale,
  type Locale,
} from '@/lib/locales'
import { describePricing } from '@/lib/pricing'
import { parseTabs } from '@/lib/tabs'

type Product = typeof products.$inferSelect

/**
 * Shape returned by the public routes and consumed by the website, rendered in one locale.
 *
 * The prose fields arrive already resolved — a caller reads `name`, never `translations.es.name` —
 * so a website asking for `es` needs no merging logic of its own and a half-translated page simply
 * shows the fields that were translated. `locale` says which language the text came out in and
 * `available_locales` which ones could have been asked for.
 */
const toPublicProduct = (product: Product, requested: Locale = DEFAULT_LOCALE) => {
  const translations = parseTranslations(product.translations)
  const locale = resolveLocale(translations, requested)

  const localized = localize(
    {
      name: product.name,
      tagline: product.tagline,
      summary: product.summary,
      overview_body: product.overviewBody,
      contact_body: product.contactBody,
    },
    translations,
    locale,
    PRODUCT_TRANSLATABLE_FIELDS,
  )

  return {
    id: product.id,
    slug: product.slug,
    ...localized,
    locale,
    available_locales: availableLocales(translations),
    featured: product.featured,
    position: product.position,
    banner_image_url: product.bannerImageUrl,
    icon_image_url: product.iconImageUrl,
    accent_color: product.accentColor,
    tabs: parseTabs(product.tabs),
    links: parseLinks(product.links),
    // Derived rather than raw: `describePricing` nulls the price of a product that is no longer
    // paid, so a listing can never quote a figure for something currently free. See `lib/pricing.ts`.
    pricing: describePricing(product),
    published_at: product.publishedAt?.toISOString() ?? null,
    updated_at: product.updatedAt.toISOString(),
  }
}

/**
 * The same product without its two tab bodies, which is what a listing wants.
 *
 * They are Markdown documents capped at 200 kB apiece, so a list of twenty products carrying
 * both is several megabytes of text nobody on that screen is going to read. The single-product
 * read is where the bodies live.
 */
const toPublicProductSummary = (product: Product, requested: Locale = DEFAULT_LOCALE) => {
  const { overview_body: _overview, contact_body: _contact, ...summary } = toPublicProduct(product, requested)
  return summary
}

/**
 * Same product, plus the editorial fields only an authenticated editor may see.
 *
 * Always the default locale, with the raw `translations` map beside it: an editor edits the source
 * text and its translations together, and a localized `name` here would be an editor saving the
 * Spanish text back over the English row.
 */
const toAdminProduct = (product: Product) => ({
  ...toPublicProduct(product, DEFAULT_LOCALE),
  translations: parseTranslations(product.translations),
  status: product.status,
  created_by: product.createdBy,
  updated_by: product.updatedBy,
  created_at: product.createdAt.toISOString(),
})

type ListFilters = {
  status?: ContentStatus
  featured?: boolean
  /** Substring match against name, tagline, summary and slug. */
  search?: string
  limit: number
  offset: number
}

/**
 * Ordering every listing shares: the manual `position` first so an editor can pin things, then the
 * most recently published (SQLite sorts NULLs last under DESC, which is what an unpublished draft
 * wants), then name for a stable tie-break.
 */
const listOrder = [asc(products.position), desc(products.publishedAt), asc(products.name)]

const buildFilters = (filters: ListFilters): SQL | undefined => {
  const clauses: (SQL | undefined)[] = []

  if (filters.status) {
    clauses.push(eq(products.status, filters.status))
  }
  if (filters.featured !== undefined) {
    clauses.push(eq(products.featured, filters.featured))
  }
  if (filters.search) {
    const pattern = `%${filters.search.toLowerCase()}%`
    clauses.push(
      or(
        like(products.name, pattern),
        like(products.tagline, pattern),
        like(products.summary, pattern),
        like(products.slug, pattern),
      ),
    )
  }

  const present = clauses.filter((clause): clause is SQL => clause !== undefined)
  return present.length > 0 ? and(...present) : undefined
}

const listProducts = async (db: Database, filters: ListFilters): Promise<Product[]> =>
  db
    .select()
    .from(products)
    .where(buildFilters(filters))
    .orderBy(...listOrder)
    .limit(filters.limit)
    .offset(filters.offset)

const findProductById = async (db: Database, id: string): Promise<Product | null> => {
  const [product] = await db.select().from(products).where(eq(products.id, id)).limit(1)
  return product ?? null
}

const findProductBySlug = async (db: Database, slug: string): Promise<Product | null> => {
  const [product] = await db.select().from(products).where(eq(products.slug, slug)).limit(1)
  return product ?? null
}

export {
  findProductById,
  findProductBySlug,
  listProducts,
  toAdminProduct,
  toPublicProduct,
  toPublicProductSummary,
}
export type { Product, ListFilters }
