import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { availableLocales, parseTranslations } from '@/lib/locales'

/**
 * Covers `migrations/0003_seed_spanish_translations.sql`, the Spanish half of the landing page's
 * own content.
 *
 * Like `seed-content.test.ts` this file deliberately does not clear the database: the rows under
 * test are the ones the migrations wrote into this test file's own D1 instance.
 */

type Row = { collection?: string; slug: string; title: string; translations: string }

const rows = async (table: 'content_entries' | 'legal_pages'): Promise<Row[]> => {
  const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all<Row>()
  return results
}

const translationMigration = () => {
  const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith('0003_seed_spanish_translations'))
  if (!migration) {
    throw new Error('the Spanish translation seed is missing from the migrations directory')
  }
  return migration
}

describe('the Spanish translation seed', () => {
  it('translates every project, every timeline entry and both legal pages', async () => {
    const translated = (await rows('content_entries')).filter((row) => availableLocales(parseTranslations(row.translations)).includes('es'))
    const byCollection = new Map<string, string[]>()
    for (const row of translated) {
      byCollection.set(row.collection ?? '', [...(byCollection.get(row.collection ?? '') ?? []), row.slug])
    }

    // The collections the site actually renders prose from. `skills` is mostly product names, so
    // it is checked separately rather than expected to be translated end to end.
    expect(byCollection.get('projects')?.sort()).toEqual([
      'craftaro',
      'mi-utem',
      'oktobeer',
      'portfolio',
      'rubybox',
      'sonatype-central-upload',
    ])
    expect(byCollection.get('experience')).toHaveLength(5)
    expect(byCollection.get('education')).toHaveLength(1)
    expect(byCollection.get('certifications')).toHaveLength(3)

    for (const page of await rows('legal_pages')) {
      const translation = parseTranslations(page.translations).es
      expect(translation?.title, `title of ${page.slug}`).toBeTruthy()
      // A legal document served in the wrong language is the one fallback worth avoiding, so both
      // pages carry a full Spanish body rather than only a translated heading.
      expect(translation?.body?.length ?? 0, `body of ${page.slug}`).toBeGreaterThan(1000)
    }
  })

  it('translates only the skills whose names actually differ', async () => {
    const skills = (await rows('content_entries')).filter((row) => row.collection === 'skills')
    const translated = skills.filter((row) => parseTranslations(row.translations).es)

    // An override repeating the English word verbatim is a row that can only ever go stale, so
    // the product names are left alone and only the descriptive skills carry Spanish.
    expect(translated.length).toBeGreaterThan(0)
    expect(translated.length).toBeLessThan(skills.length)
    for (const skill of translated) {
      expect(parseTranslations(skill.translations).es?.title, `title of ${skill.slug}`).not.toBe(skill.title)
    }
  })

  it('writes translations the API would have accepted', async () => {
    for (const row of [...(await rows('content_entries')), ...(await rows('legal_pages'))]) {
      // `parseTranslations` drops unknown locales, unknown fields and non-string values, so a
      // round-trip that loses nothing is proof the raw SQL wrote the shape the routes read.
      const parsed = parseTranslations(row.translations)
      expect(parsed, `translations of ${row.slug}`).toEqual(JSON.parse(row.translations || '{}'))
    }
  })

  it('carries no DDL, which is what keeps it out of the drizzle journal', () => {
    for (const query of translationMigration().queries) {
      expect(query).toMatch(/^UPDATE/)
      expect(query).not.toMatch(/\b(CREATE|ALTER|DROP)\b/i)
    }
  })

  it('never clobbers a translation an editor has since rewritten', async () => {
    // Every statement is guarded on `translations = '{}'`, which is what makes re-applying the
    // migration a no-op rather than a silent revert of the CMS.
    for (const query of translationMigration().queries) {
      expect(query).toMatch(/`translations` = '\{\}'/)
    }

    const [project] = (await rows('content_entries')).filter((row) => row.slug === 'mi-utem')
    await env.DB.prepare("UPDATE content_entries SET translations = ? WHERE slug = 'mi-utem'")
      .bind(JSON.stringify({ es: { title: 'Edited by hand' } }))
      .run()

    for (const query of translationMigration().queries) {
      await env.DB.prepare(query).run()
    }

    const [after] = (await rows('content_entries')).filter((row) => row.slug === 'mi-utem')
    expect(parseTranslations(after.translations).es?.title).toBe('Edited by hand')
    expect(after.title).toBe(project.title)
  })
})
