import { env } from 'cloudflare:test'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { COLLECTION_NAMES, parseCollectionData } from '@/lib/collections'
import { SLUG_PATTERN } from '@/lib/slug'

/**
 * Covers `migrations/0001_seed_landing_content.sql`, the landing page's own content.
 *
 * This file deliberately does **not** clear the database: the rows under test are the ones the
 * migration wrote, and the pool gives every test file its own D1 instance with the real
 * `migrations/` directory already applied.
 *
 * What is worth pinning is that the seed is data the *API* would have accepted. Nothing validates a
 * hand-written INSERT on its way in, so a misspelled key inside a `data` blob would sit there
 * unnoticed until an editor opened that entry in the CMS and found they could never save it again —
 * `PATCH` replaces `data` wholesale and validates it against the same strict schema.
 */

type EntryRow = {
  collection: string
  slug: string
  title: string
  status: string
  featured: number
  position: number
  tags: string
  data: string
}

const entries = async (collection?: string): Promise<EntryRow[]> => {
  const statement = collection
    ? env.DB.prepare('SELECT * FROM content_entries WHERE collection = ? ORDER BY position').bind(collection)
    : env.DB.prepare('SELECT * FROM content_entries ORDER BY collection, position')
  const { results } = await statement.all<EntryRow>()
  return results
}

const seedMigration = () => {
  const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith('0001_seed_landing_content'))
  if (!migration) {
    throw new Error('the seed migration is missing from the migrations directory')
  }
  return migration
}

describe('the seed migration', () => {
  it('fills every collection the content model declares', async () => {
    const counts = new Map<string, number>()
    for (const entry of await entries()) {
      counts.set(entry.collection, (counts.get(entry.collection) ?? 0) + 1)
    }

    for (const collection of COLLECTION_NAMES) {
      expect(counts.get(collection) ?? 0).toBeGreaterThan(0)
    }
    // Only collections the registry knows about: a row under an unknown name is invisible to
    // every route in this Worker and would only ever be found by reading the table by hand.
    expect([...counts.keys()].every((collection) => COLLECTION_NAMES.includes(collection as never))).toBe(true)
  })

  it('writes entries the admin API would have accepted', async () => {
    for (const entry of await entries()) {
      expect(SLUG_PATTERN.test(entry.slug), `slug ${entry.slug}`).toBe(true)
      expect(entry.title.length, `title of ${entry.slug}`).toBeLessThanOrEqual(200)

      // The real point of this file: a strict schema rejects an unknown or misspelled key, so this
      // fails loudly here rather than the first time an editor tries to save the entry.
      const data = JSON.parse(entry.data) as unknown
      expect(() => parseCollectionData(entry.collection as never, data), `data of ${entry.slug}`).not.toThrow()

      // Tags are stored lowercased so `?tag=` does not have to care about casing.
      const tags = v.parse(v.array(v.string()), JSON.parse(entry.tags))
      expect(tags, `tags of ${entry.slug}`).toEqual(tags.map((tag) => tag.toLowerCase()))
    }
  })

  it('publishes everything it writes, so the website can actually read it', async () => {
    for (const entry of await entries()) {
      expect(entry.status, `status of ${entry.slug}`).toBe('published')
    }

    const { results } = await env.DB.prepare(
      'SELECT slug, status, version, effective_at, published_at FROM legal_pages',
    ).all<{ slug: string; status: string; version: string | null; effective_at: number | null; published_at: number | null }>()

    expect(results.map((page) => page.slug).sort()).toEqual(['privacy-policy', 'terms-of-service'])
    for (const page of results) {
      expect(page.status).toBe('published')
      // A published policy that cannot say which version it is, or when it took effect, is the one
      // thing a legal page must never be.
      expect(page.version).toBeTruthy()
      expect(page.effective_at).toBeTruthy()
      expect(page.published_at).toBeTruthy()
    }
  })

  it('orders each collection the way the site renders it', async () => {
    for (const collection of COLLECTION_NAMES) {
      const positions = (await entries(collection)).map((entry) => entry.position)
      // Contiguous from zero: `POST /admin/content/:collection/reorder` rewrites the whole list,
      // so a gap here would silently close the first time anything is dragged.
      expect(positions, collection).toEqual(positions.map((_, index) => index))
    }
  })

  it('marks as featured exactly the projects the landing page features', async () => {
    const featured = (await entries('projects')).filter((entry) => entry.featured === 1)

    expect(featured.map((entry) => entry.slug)).toEqual(['mi-utem', 'oktobeer', 'portfolio', 'craftaro'])
  })

  it('is idempotent, so re-applying it never doubles a row', async () => {
    const before = (await entries()).length
    const [row] = await entries('projects')

    await env.DB.prepare('INSERT OR IGNORE INTO content_entries (id, collection, slug, title) VALUES (?, ?, ?, ?)')
      .bind(crypto.randomUUID(), row.collection, row.slug, 'A second copy')
      .run()

    expect((await entries()).length).toBe(before)
  })

  it('carries no DDL, which is what keeps it out of the drizzle journal', () => {
    // The file is hand-written and absent from `migrations/meta/_journal.json` on purpose: drizzle
    // did not generate it, so its snapshot stays an accurate picture of the schema only for as long
    // as this migration never changes one.
    for (const query of seedMigration().queries) {
      expect(query).toMatch(/INSERT OR IGNORE INTO/)
      expect(query).not.toMatch(/\b(CREATE|ALTER|DROP)\b/i)
    }
  })
})
