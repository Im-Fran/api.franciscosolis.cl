import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getGitHubStars } from '@/stats/github/stars'
import {
  axiosPost,
  expectedGitHubHeaders,
  githubResponse,
  graphqlErrorPayload,
  resetAxios,
  starsPage,
} from '../helpers/github'

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }))

const TOKEN = 'stars-token'
const LAST_PAGE = { hasNextPage: false, endCursor: null }

const postedBody = (call: number) => axiosPost().mock.calls[call][1]
const postedConfig = (call: number) => axiosPost().mock.calls[call][2]

beforeEach(resetAxios)

describe('getGitHubStars', () => {
  it('sums the stargazers of every repository on a single page', async () => {
    axiosPost().mockResolvedValue(starsPage([120, 34, 7], LAST_PAGE))

    await expect(getGitHubStars({ GH_TOKEN: TOKEN })).resolves.toBe(161)
  })

  it('returns 0 for an account that owns no repositories', async () => {
    axiosPost().mockResolvedValue(starsPage([], LAST_PAGE))

    await expect(getGitHubStars({ GH_TOKEN: TOKEN })).resolves.toBe(0)
    expect(axiosPost()).toHaveBeenCalledTimes(1)
  })

  it('counts unstarred repositories without breaking the sum', async () => {
    axiosPost().mockResolvedValue(starsPage([0, 0, 5, 0], LAST_PAGE))

    await expect(getGitHubStars({ GH_TOKEN: TOKEN })).resolves.toBe(5)
  })

  it('posts the paginated owner query to the GraphQL endpoint with a null starting cursor', async () => {
    axiosPost().mockResolvedValue(starsPage([1], LAST_PAGE))

    await getGitHubStars({ GH_TOKEN: TOKEN })

    expect(axiosPost().mock.calls[0][0]).toBe('https://api.github.com/graphql')
    expect(postedBody(0).variables).toEqual({ login: 'Im-Fran', after: null })
    expect(postedBody(0).query).toContain('query getAllStars($login: String!, $after: String)')
    expect(postedBody(0).query).toContain('ownerAffiliations: OWNER')
    expect(postedBody(0).query).toContain('first: 100')
  })

  it('sends the token in the GraphQL request headers', async () => {
    axiosPost().mockResolvedValue(starsPage([1], LAST_PAGE))

    await getGitHubStars({ GH_TOKEN: TOKEN })

    expect(postedConfig(0)).toEqual({ headers: expectedGitHubHeaders(TOKEN) })
  })

  it('follows hasNextPage and feeds endCursor back as the next `after`', async () => {
    axiosPost()
      .mockResolvedValueOnce(starsPage([10, 5], { hasNextPage: true, endCursor: 'cursor-page-2' }))
      .mockResolvedValueOnce(starsPage([3], LAST_PAGE))

    await expect(getGitHubStars({ GH_TOKEN: TOKEN })).resolves.toBe(18)

    expect(axiosPost()).toHaveBeenCalledTimes(2)
    expect(postedBody(0).variables.after).toBeNull()
    expect(postedBody(1).variables.after).toBe('cursor-page-2')
  })

  it('keeps walking across more than two pages and totals them all', async () => {
    axiosPost()
      .mockResolvedValueOnce(starsPage([100], { hasNextPage: true, endCursor: 'c1' }))
      .mockResolvedValueOnce(starsPage([50, 50], { hasNextPage: true, endCursor: 'c2' }))
      .mockResolvedValueOnce(starsPage([1, 2, 3], LAST_PAGE))

    await expect(getGitHubStars({ GH_TOKEN: TOKEN })).resolves.toBe(206)

    expect(axiosPost().mock.calls.map((call: unknown[]) => (call[1] as any).variables.after)).toEqual(
      [null, 'c1', 'c2'],
    )
  })

  it('stops on hasNextPage false even when GitHub still hands back a cursor', async () => {
    // GitHub always returns the last cursor; only `hasNextPage` may end the walk.
    axiosPost().mockResolvedValue(starsPage([9], { hasNextPage: false, endCursor: 'trailing' }))

    await expect(getGitHubStars({ GH_TOKEN: TOKEN })).resolves.toBe(9)
    expect(axiosPost()).toHaveBeenCalledTimes(1)
  })

  it('keeps the query identical across pages, changing only the cursor', async () => {
    axiosPost()
      .mockResolvedValueOnce(starsPage([1], { hasNextPage: true, endCursor: 'c1' }))
      .mockResolvedValueOnce(starsPage([1], LAST_PAGE))

    await getGitHubStars({ GH_TOKEN: TOKEN })

    expect(postedBody(1).query).toBe(postedBody(0).query)
    expect(postedBody(1).variables.login).toBe('Im-Fran')
  })

  it('re-sends the token on every page, not only on the first request', async () => {
    // The headers are rebuilt inside the loop; dropping the token after page one would still return
    // a plausible total in production, because GraphQL answers unauthenticated requests with a 200.
    axiosPost()
      .mockResolvedValueOnce(starsPage([1], { hasNextPage: true, endCursor: 'c1' }))
      .mockResolvedValueOnce(starsPage([1], { hasNextPage: true, endCursor: 'c2' }))
      .mockResolvedValueOnce(starsPage([1], LAST_PAGE))

    await getGitHubStars({ GH_TOKEN: TOKEN })

    expect(axiosPost()).toHaveBeenCalledTimes(3)
    expect(postedConfig(1)).toEqual({ headers: expectedGitHubHeaders(TOKEN) })
    expect(postedConfig(2)).toEqual({ headers: expectedGitHubHeaders(TOKEN) })
  })

  it('always posts to the GraphQL endpoint, never to a per-page URL', async () => {
    axiosPost()
      .mockResolvedValueOnce(starsPage([1], { hasNextPage: true, endCursor: 'c1' }))
      .mockResolvedValueOnce(starsPage([1], LAST_PAGE))

    await getGitHubStars({ GH_TOKEN: TOKEN })

    expect(axiosPost().mock.calls.map((call: unknown[]) => call[0])).toEqual([
      'https://api.github.com/graphql',
      'https://api.github.com/graphql',
    ])
  })

  // KNOWN BUG (reported, not fixed here): the walk has no page ceiling and no cursor-progress check.
  // A test cannot assert non-termination safely, so this pins the mechanism behind it — the second
  // request is byte-for-byte the first one, and only the stub's own `hasNextPage: false` ends it.
  // In production that answer loops forever and burns the Worker's CPU budget.
  it('re-requests the first page when hasNextPage is true but endCursor is null', async () => {
    axiosPost()
      .mockResolvedValueOnce(starsPage([7], { hasNextPage: true, endCursor: null }))
      .mockResolvedValueOnce(starsPage([7], LAST_PAGE))

    await expect(getGitHubStars({ GH_TOKEN: TOKEN })).resolves.toBe(14)

    expect(postedBody(1).variables.after).toBeNull()
    expect(postedBody(1)).toEqual(postedBody(0))
  })

  it('double counts a page GitHub hands back twice, having no seen-cursor guard', async () => {
    axiosPost()
      .mockResolvedValueOnce(starsPage([30], { hasNextPage: true, endCursor: 'stuck' }))
      .mockResolvedValueOnce(starsPage([30], { hasNextPage: true, endCursor: 'stuck' }))
      .mockResolvedValueOnce(starsPage([30], LAST_PAGE))

    await expect(getGitHubStars({ GH_TOKEN: TOKEN })).resolves.toBe(90)
    expect(postedBody(1).variables.after).toBe('stuck')
    expect(postedBody(2).variables.after).toBe('stuck')
  })

  // GitHub's GraphQL API answers bad credentials, an exhausted rate limit and a suspended account
  // with an HTTP 200 carrying `errors`, so axios resolves and none of the rejection stubs above
  // reach this path. The dereference is unguarded — pinned here, and reported as a bug.
  it('throws a raw dereference error when GraphQL reports failure in-band with a null user', async () => {
    axiosPost().mockResolvedValue(graphqlErrorPayload('Bad credentials'))

    await expect(getGitHubStars({ GH_TOKEN: TOKEN })).rejects.toThrowError(
      /Cannot read properties of null \(reading 'repositories'\)/,
    )
  })

  it('throws rather than reporting 0 when the repositories connection itself is null', async () => {
    axiosPost().mockResolvedValue(githubResponse({ data: { user: { repositories: null } } }))

    await expect(getGitHubStars({ GH_TOKEN: TOKEN })).rejects.toThrowError(
      /Cannot read properties of null \(reading 'nodes'\)/,
    )
  })

  it('does not return a partial total when a later page fails in-band', async () => {
    axiosPost()
      .mockResolvedValueOnce(starsPage([40], { hasNextPage: true, endCursor: 'c1' }))
      .mockResolvedValueOnce(graphqlErrorPayload('API rate limit exceeded', 'RATE_LIMITED'))

    await expect(getGitHubStars({ GH_TOKEN: TOKEN })).rejects.toThrowError(TypeError)
    expect(axiosPost()).toHaveBeenCalledTimes(2)
  })

  it('counts a page that arrives alongside a partial-failure errors array', async () => {
    // GraphQL may return both `data` and `errors`; the walk ignores `errors` entirely, so a
    // partially failed page still contributes its nodes to the total.
    axiosPost().mockResolvedValue(
      githubResponse({
        data: {
          user: {
            repositories: {
              nodes: [{ stargazers: { totalCount: 12 } }],
              pageInfo: LAST_PAGE,
            },
          },
        },
        errors: [{ message: 'Something went wrong while executing your query' }],
      }),
    )

    await expect(getGitHubStars({ GH_TOKEN: TOKEN })).resolves.toBe(12)
  })

  it('propagates a failure on the first page', async () => {
    const failure = new Error('GraphQL: Bad credentials')
    axiosPost().mockRejectedValue(failure)

    await expect(getGitHubStars({ GH_TOKEN: TOKEN })).rejects.toBe(failure)
  })

  it('propagates a failure mid-pagination rather than returning a partial total', async () => {
    const failure = new Error('502 Bad Gateway')
    axiosPost()
      .mockResolvedValueOnce(starsPage([40], { hasNextPage: true, endCursor: 'c1' }))
      .mockRejectedValueOnce(failure)

    await expect(getGitHubStars({ GH_TOKEN: TOKEN })).rejects.toBe(failure)
    expect(axiosPost()).toHaveBeenCalledTimes(2)
  })
})
