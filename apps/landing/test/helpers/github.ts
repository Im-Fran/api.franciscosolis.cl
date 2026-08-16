import axios from 'axios'
import type { Mock } from 'vitest'

/**
 * The GitHub helpers only ever read `status`, `statusText` and `data` off an axios response, so the
 * doubles stop there instead of faking a whole `AxiosResponse`.
 */
type ResponseStub = {
  status: number
  statusText: string
  data: unknown
}

const githubResponse = (data: unknown, status = 200, statusText = 'OK'): ResponseStub => ({
  status,
  statusText,
  data,
})

/**
 * `axios` is replaced by a `vi.mock` factory in every test file that pulls this helper in, so the
 * imported binding is already the stub; the cast only strips axios' overloaded generic signatures.
 */
const axiosGet = () => axios.get as unknown as Mock
const axiosPost = () => axios.post as unknown as Mock

const resetAxios = () => {
  axiosGet().mockReset()
  axiosPost().mockReset()
}

/**
 * Pinned literally instead of imported from `src/stats/github/headers`, so a regression in the
 * header builder breaks every caller's test rather than silently agreeing with itself.
 */
const expectedGitHubHeaders = (token: string) => ({
  Authorization: `token ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'FranciscoSolis-Portfolio-Api/1.0',
})

type PageInfo = {
  hasNextPage: boolean
  endCursor: string | null
}

/** One page of the `getAllStars` GraphQL query, wrapped in the axios + GraphQL envelopes. */
const starsPage = (stargazerCounts: number[], pageInfo: PageInfo) =>
  githubResponse({
    data: {
      user: {
        repositories: {
          nodes: stargazerCounts.map((totalCount) => ({ stargazers: { totalCount } })),
          pageInfo,
        },
      },
    },
  })

const pullRequestsPayload = (totalCount: number) =>
  githubResponse({ data: { user: { pullRequests: { totalCount } } } })

const profilePayload = (overrides: Record<string, unknown> = {}) => ({
  login: 'Im-Fran',
  id: 20404280,
  avatar_url: 'https://avatars.githubusercontent.com/u/20404280?v=4',
  html_url: 'https://github.com/Im-Fran',
  public_repos: 42,
  total_private_repos: 8,
  followers: 137,
  following: 12,
  location: 'Santiago, Chile',
  email: 'private@example.invalid',
  ...overrides,
})

const readJson = async <T>(response: Response): Promise<T> => (await response.json()) as T

export {
  axiosGet,
  axiosPost,
  expectedGitHubHeaders,
  githubResponse,
  profilePayload,
  pullRequestsPayload,
  readJson,
  resetAxios,
  starsPage,
}
