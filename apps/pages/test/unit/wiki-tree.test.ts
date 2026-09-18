import { describe, expect, it } from 'vitest'
import { buildWikiTree } from '@/services/wiki'
import type { WikiPage } from '@/services/wiki'

const page = (over: Partial<WikiPage> & { id: string }): WikiPage => ({
  applicationId: 'app-1',
  parentId: null,
  slug: over.id,
  title: over.id,
  icon: null,
  body: '# body',
  status: 'published',
  position: 0,
  translations: '{}',
  publishedAt: null,
  createdBy: null,
  updatedBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
})

describe('buildWikiTree', () => {
  it('nests a page under its section', () => {
    const tree = buildWikiTree([page({ id: 'overview' }), page({ id: 'commands', parentId: 'overview' })])

    expect(tree).toHaveLength(1)
    expect(tree[0]?.id).toBe('overview')
    expect(tree[0]?.children.map((child) => child.id)).toEqual(['commands'])
  })

  it('leaves the bodies out — a sidebar is not a second copy of the wiki', () => {
    const [node] = buildWikiTree([page({ id: 'overview' })])

    expect(node).not.toHaveProperty('body')
  })

  /**
   * The case this exists for: a section left as a draft is absent from the published list, and
   * dropping its children with it would make an unpublished heading hide published documentation.
   */
  it('promotes a page whose parent is not in the list instead of dropping it', () => {
    const tree = buildWikiTree([page({ id: 'commands', parentId: 'a-draft-section' })])

    expect(tree.map((node) => node.id)).toEqual(['commands'])
  })

  it('promotes a page that points at itself rather than losing it to a cycle', () => {
    const tree = buildWikiTree([page({ id: 'loop', parentId: 'loop' })])

    expect(tree.map((node) => node.id)).toEqual(['loop'])
    expect(tree[0]?.children).toEqual([])
  })

  it('keeps the order it was handed, which is the order the query sorted', () => {
    const tree = buildWikiTree([
      page({ id: 'install', position: 0 }),
      page({ id: 'features', position: 1 }),
      page({ id: 'api', position: 2 }),
    ])

    expect(tree.map((node) => node.id)).toEqual(['install', 'features', 'api'])
  })
})
