import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getGitHubCommits } from '@/stats/github/commits'
import { axiosGet, expectedGitHubHeaders, githubResponse, resetAxios } from '../helpers/github'

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }))

const TOKEN = 'commits-token'

beforeEach(resetAxios)

describe('getGitHubCommits', () => {
  it('returns the search API total_count on a 200', async () => {
    axiosGet().mockResolvedValue(githubResponse({ total_count: 12431 }))

    await expect(getGitHubCommits({ GH_TOKEN: TOKEN })).resolves.toBe(12431)
  })

  it('returns 0 for an account with no commits, without confusing it for a failure', async () => {
    axiosGet().mockResolvedValue(githubResponse({ total_count: 0, incomplete_results: false }))

    await expect(getGitHubCommits({ GH_TOKEN: TOKEN })).resolves.toBe(0)
  })

  it('queries the commit search endpoint for the account exactly once', async () => {
    axiosGet().mockResolvedValue(githubResponse({ total_count: 1 }))

    await getGitHubCommits({ GH_TOKEN: TOKEN })

    expect(axiosGet()).toHaveBeenCalledTimes(1)
    expect(axiosGet()).toHaveBeenCalledWith(
      'https://api.github.com/search/commits?q=author:Im-Fran',
      { headers: expectedGitHubHeaders(TOKEN) },
    )
  })

  it('forwards the token it was handed rather than a cached one', async () => {
    axiosGet().mockResolvedValue(githubResponse({ total_count: 1 }))

    await getGitHubCommits({ GH_TOKEN: 'first-token' })
    await getGitHubCommits({ GH_TOKEN: 'second-token' })

    expect(axiosGet().mock.calls[0][1].headers.Authorization).toBe('token first-token')
    expect(axiosGet().mock.calls[1][1].headers.Authorization).toBe('token second-token')
  })

  // axios' default `validateStatus` rejects anything outside 2xx, so the `status === 200` guard is
  // what handles the 2xx-but-not-200 answers; 4xx/5xx arrive as rejections instead.
  it('reports 0 on a 202, which the search API returns while it warms its index', async () => {
    // The body carries no usable count yet, so it must not be trusted even though it parses.
    axiosGet().mockResolvedValue(githubResponse({ total_count: 999 }, 202, 'Accepted'))

    await expect(getGitHubCommits({ GH_TOKEN: TOKEN })).resolves.toBe(0)
  })

  it('reports 0 on a 204, where there is no body to read a count from', async () => {
    axiosGet().mockResolvedValue(githubResponse('', 204, 'No Content'))

    await expect(getGitHubCommits({ GH_TOKEN: TOKEN })).resolves.toBe(0)
  })

  it('propagates a failed request instead of swallowing it into a 0', async () => {
    const failure = new Error('getaddrinfo ENOTFOUND api.github.com')
    axiosGet().mockRejectedValue(failure)

    await expect(getGitHubCommits({ GH_TOKEN: TOKEN })).rejects.toBe(failure)
  })

  // KNOWN BUG (reported, not fixed here): `total_count` is read without a guard, so a 200 whose body
  // is not a search result yields `undefined` — a value the route then publishes as a number. These
  // pin the current behaviour so it cannot degrade further, and so a fix cannot land silently.
  it('yields undefined, not 0, when a 200 body carries no total_count at all', async () => {
    axiosGet().mockResolvedValue(githubResponse({}))

    await expect(getGitHubCommits({ GH_TOKEN: TOKEN })).resolves.toBeUndefined()
  })

  it('yields undefined when a 200 body is an error document instead of a search result', async () => {
    // The search API answers 200 with this shape for a secondary rate limit rather than a 403.
    axiosGet().mockResolvedValue(
      githubResponse({
        message: 'You have exceeded a secondary rate limit',
        documentation_url: 'https://docs.github.com/rest/search',
      }),
    )

    await expect(getGitHubCommits({ GH_TOKEN: TOKEN })).resolves.toBeUndefined()
  })
})
