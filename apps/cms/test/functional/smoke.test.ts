import { SELF, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

/**
 * Covers what the rest of this app's suite stands on: the real `migrations/` directory applies to
 * a fresh database, the Worker boots, and the JWKS URL under test cannot reach the production auth
 * Worker. If any of those breaks, the other failures in this app are symptoms rather than causes.
 */
describe('cms smoke', () => {
  it('applies the schema', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations' ORDER BY name",
    ).all<{ name: string }>()

    expect(results.map((row) => row.name)).toEqual(
      expect.arrayContaining(['audit_logs', 'content_entries']),
    )
  })

  it('enforces one slug per collection, not one slug overall', async () => {
    const insert = (collection: string, slug: string) =>
      env.DB.prepare('INSERT INTO content_entries (id, collection, slug, title) VALUES (?, ?, ?, ?)')
        .bind(`${collection}-${slug}`, collection, slug, 'Title')
        .run()

    await insert('projects', 'shared-slug')
    // The unique index is (collection, slug), so the same slug in another collection is allowed…
    await expect(insert('skills', 'shared-slug')).resolves.toBeTruthy()
    // …while a repeat inside one collection is not.
    await expect(insert('projects', 'shared-slug')).rejects.toThrow(/UNIQUE constraint failed/i)
  })

  it('defaults a new entry to draft, so nothing is published by accident', async () => {
    await env.DB.prepare('INSERT INTO content_entries (id, collection, slug, title) VALUES (?, ?, ?, ?)')
      .bind('default-status', 'projects', 'default-status', 'Title')
      .run()

    const row = await env.DB.prepare('SELECT status, published_at FROM content_entries WHERE id = ?')
      .bind('default-status')
      .first<{ status: string; published_at: number | null }>()

    expect(row?.status).toBe('draft')
    expect(row?.published_at).toBeNull()
  })

  it('answers its root', async () => {
    const response = await SELF.fetch('https://cms.internal/')

    expect(response.status).toBe(200)
  })

  it('points the JWKS URL at an unroutable host under test', () => {
    // A stub that stops matching must fail loudly, never silently reach the real auth Worker.
    expect(env.AUTH_JWKS_URL).toBe('https://auth.test/.well-known/jwks.json')
    expect(env.AUTH_ISSUER).toBe('https://auth.test')
  })
})
