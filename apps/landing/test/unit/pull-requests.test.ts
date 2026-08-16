import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getGitHubPullRequests } from '@/stats/github/pull-requests'
import {
  axiosPost,
  expectedGitHubHeaders,
  githubResponse,
  graphqlErrorPayload,
  pullRequestsPayload,
  resetAxios,
} from '../helpers/github'

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }))

const TOKEN = 'pull-requests-token'

beforeEach(resetAxios)

// No route mounts this helper yet, but it is exported and the gateway's spec merge would pick up a
// route added on top of it, so its GraphQL contract is pinned here.
describe('getGitHubPullRequests', () => {
  it('unwraps the totalCount out of the GraphQL envelope', async () => {
    axiosPost().mockResolvedValue(pullRequestsPayload(412))

    await expect(getGitHubPullRequests({ GH_TOKEN: TOKEN })).resolves.toBe(412)
  })

  it('returns 0 for an account that has opened none', async () => {
    axiosPost().mockResolvedValue(pullRequestsPayload(0))

    await expect(getGitHubPullRequests({ GH_TOKEN: TOKEN })).resolves.toBe(0)
  })

  it('posts the pull request count query to the GraphQL endpoint once', async () => {
    axiosPost().mockResolvedValue(pullRequestsPayload(1))

    await getGitHubPullRequests({ GH_TOKEN: TOKEN })

    expect(axiosPost()).toHaveBeenCalledTimes(1)
    expect(axiosPost().mock.calls[0][0]).toBe('https://api.github.com/graphql')

    const body = axiosPost().mock.calls[0][1]
    expect(body.query).toContain('query getPullRequestCount($login: String!)')
    expect(body.query).toContain('pullRequests')
    expect(body.query).toContain('totalCount')
  })

  it('sends only the login variable, since this query does not paginate', async () => {
    axiosPost().mockResolvedValue(pullRequestsPayload(1))

    await getGitHubPullRequests({ GH_TOKEN: TOKEN })

    expect(axiosPost().mock.calls[0][1].variables).toEqual({ login: 'Im-Fran' })
  })

  it('sends the token in the GraphQL request headers', async () => {
    axiosPost().mockResolvedValue(pullRequestsPayload(1))

    await getGitHubPullRequests({ GH_TOKEN: TOKEN })

    expect(axiosPost().mock.calls[0][2]).toEqual({ headers: expectedGitHubHeaders(TOKEN) })
  })

  it('propagates a failed request', async () => {
    const failure = new Error('GraphQL: Could not resolve to a User')
    axiosPost().mockRejectedValue(failure)

    await expect(getGitHubPullRequests({ GH_TOKEN: TOKEN })).rejects.toBe(failure)
  })

  // Same unguarded dereference as `stars.ts`, and the same reason it matters: GitHub reports bad
  // credentials, rate limits and an unresolvable login as an HTTP 200 with `errors`, so this is the
  // ordinary failure path rather than an exotic one. Reported as a bug; pinned here as it stands.
  it('throws a raw dereference error when GraphQL reports failure in-band with a null user', async () => {
    axiosPost().mockResolvedValue(graphqlErrorPayload('Bad credentials', 'UNAUTHORIZED'))

    await expect(getGitHubPullRequests({ GH_TOKEN: TOKEN })).rejects.toThrowError(
      /Cannot read properties of null \(reading 'pullRequests'\)/,
    )
  })

  it('returns the count anyway when GraphQL reports a partial failure alongside the data', async () => {
    axiosPost().mockResolvedValue(
      githubResponse({
        data: { user: { pullRequests: { totalCount: 9 } } },
        errors: [{ message: 'Something went wrong while executing your query' }],
      }),
    )

    await expect(getGitHubPullRequests({ GH_TOKEN: TOKEN })).resolves.toBe(9)
  })
})
