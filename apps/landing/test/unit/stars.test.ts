import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getGitHubStars } from '@/stats/github/stars'
import { axiosPost, expectedGitHubHeaders, resetAxios, starsPage } from '../helpers/github'

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
