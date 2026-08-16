import { beforeEach, describe, expect, it } from 'vitest'
import type { LegalPage } from '@/services/legal'
import { findPageById, findPageBySlug, toAdminPage, toPublicPage, toPublicSummary } from '@/services/legal'
import { clearDatabase, db, seedLegalPage } from '../helpers/db'

beforeEach(clearDatabase)

describe('findPageById / findPageBySlug', () => {
  it('finds an existing page both ways', async () => {
    const row = await seedLegalPage({ slug: 'privacy', title: 'Privacy policy' })

    expect((await findPageById(db(), row.id))?.slug).toBe('privacy')
    expect((await findPageBySlug(db(), 'privacy'))?.id).toBe(row.id)
  })

  it('returns null rather than throwing when there is nothing to find', async () => {
    expect(await findPageById(db(), 'no-such-id')).toBeNull()
    expect(await findPageBySlug(db(), 'no-such-slug')).toBeNull()
  })

  it('finds a draft, leaving the status rule to the caller', async () => {
    await seedLegalPage({ slug: 'terms', status: 'draft' })

    expect((await findPageBySlug(db(), 'terms'))?.status).toBe('draft')
  })

  it('matches the slug exactly, not by prefix', async () => {
    await seedLegalPage({ slug: 'privacy-policy' })

    expect(await findPageBySlug(db(), 'privacy')).toBeNull()
  })
})

describe('toPublicPage', () => {
  it('renders the document as a visitor sees it', async () => {
    const effective = new Date('2026-08-01T00:00:00.000Z')
    const row = await seedLegalPage({
      slug: 'privacy',
      title: 'Privacy policy',
      summary: 'What we keep',
      body: '# Privacy',
      version: '2026-08',
      effectiveAt: effective,
    })

    const page = (await findPageById(db(), row.id)) as LegalPage
    expect(toPublicPage(page)).toEqual({
      id: row.id,
      slug: 'privacy',
      title: 'Privacy policy',
      summary: 'What we keep',
      body: '# Privacy',
      version: '2026-08',
      effective_at: '2026-08-01T00:00:00.000Z',
      published_at: expect.any(String),
      updated_at: expect.any(String),
    })
  })

  it('nulls the dates it has none of', async () => {
    const row = await seedLegalPage({ effectiveAt: null, publishedAt: null })
    const page = (await findPageById(db(), row.id)) as LegalPage

    expect(toPublicPage(page).effective_at).toBeNull()
    expect(toPublicPage(page).published_at).toBeNull()
  })

  it('never leaks the editorial fields', async () => {
    const row = await seedLegalPage({ status: 'draft' })
    const shape = toPublicPage((await findPageById(db(), row.id)) as LegalPage)

    expect(shape).not.toHaveProperty('status')
    expect(shape).not.toHaveProperty('created_by')
    expect(shape).not.toHaveProperty('updated_by')
  })
})

describe('toPublicSummary', () => {
  it('drops the body, which is far too long for an index', async () => {
    const row = await seedLegalPage({ body: '# A very long legal document' })
    const summary = toPublicSummary(toPublicPage((await findPageById(db(), row.id)) as LegalPage))

    expect(summary).not.toHaveProperty('body')
    expect(summary.slug).toBe(row.slug)
    expect(summary.title).toBe('Seeded page')
  })

  it('keeps every other public field', async () => {
    const row = await seedLegalPage({ version: '1.2' })
    const summary = toPublicSummary(toPublicPage((await findPageById(db(), row.id)) as LegalPage))

    expect(Object.keys(summary).sort()).toEqual([
      'effective_at',
      'id',
      'published_at',
      'slug',
      'summary',
      'title',
      'updated_at',
      'version',
    ])
  })
})

describe('toAdminPage', () => {
  it('adds status and the authorship fields', async () => {
    const row = await seedLegalPage({
      status: 'archived',
      createdBy: 'a@franciscosolis.cl',
      updatedBy: 'b@franciscosolis.cl',
    })
    const shape = toAdminPage((await findPageById(db(), row.id)) as LegalPage)

    expect(shape.status).toBe('archived')
    expect(shape.created_by).toBe('a@franciscosolis.cl')
    expect(shape.updated_by).toBe('b@franciscosolis.cl')
    expect(shape.created_at).toEqual(expect.any(String))
    expect(shape.body).toBe('# Seeded page')
  })
})
