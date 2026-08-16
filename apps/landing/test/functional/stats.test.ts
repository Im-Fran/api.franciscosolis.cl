import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  axiosGet,
  axiosPost,
  githubResponse,
  profilePayload,
  readJson,
  resetAxios,
  starsPage,
} from '../helpers/github'

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }))

const BASE = 'https://landing.internal'
const LAST_PAGE = { hasNextPage: false, endCursor: null }

// Injected by `vitest.config.ts`; asserting on it proves `c.env` reaches the GitHub helpers.
const BOUND_TOKEN = 'test-github-token'

beforeEach(resetAxios)

describe('GET /stats/github', () => {
  it('lists the available GitHub stats endpoints', async () => {
    const response = await SELF.fetch(`${BASE}/stats/github`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      code: 200,
      data: {
        message: '¡Hello, GitHub Stats API!',
        endpoints: ['/stats/github/commits', '/stats/github/profile', '/stats/github/stars'],
      },
    })
  })

  it('advertises only endpoints the Worker actually serves', async () => {
    axiosGet().mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/search/commits')
          ? githubResponse({ total_count: 1 })
          : githubResponse(profilePayload()),
      ),
    )
    axiosPost().mockResolvedValue(starsPage([1], LAST_PAGE))

    const listed = await readJson<{ data: { endpoints: string[] } }>(
      await SELF.fetch(`${BASE}/stats/github`),
    )

    for (const endpoint of listed.data.endpoints) {
      const response = await SELF.fetch(`${BASE}${endpoint}`)
      expect(response.status, `${endpoint} should be routable`).toBe(200)
    }
  })

  it('answers 404 for an unknown stats endpoint', async () => {
    const response = await SELF.fetch(`${BASE}/stats/github/unknown`)

    expect(response.status).toBe(404)
  })
})

describe('GET /stats/github/commits', () => {
  it('wraps the upstream count in the standard envelope', async () => {
    axiosGet().mockResolvedValue(githubResponse({ total_count: 8321 }))

    const response = await SELF.fetch(`${BASE}/stats/github/commits`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ code: 200, data: 8321 })
  })

  it('calls GitHub with the token bound to the Worker', async () => {
    axiosGet().mockResolvedValue(githubResponse({ total_count: 1 }))

    await SELF.fetch(`${BASE}/stats/github/commits`)

    expect(axiosGet().mock.calls[0][0]).toBe(
      'https://api.github.com/search/commits?q=author:Im-Fran',
    )
    expect(axiosGet().mock.calls[0][1].headers.Authorization).toBe(`token ${BOUND_TOKEN}`)
  })

  it('still answers 200 with 0 when GitHub declines to give a count', async () => {
    axiosGet().mockResolvedValue(githubResponse({ total_count: 42 }, 202, 'Accepted'))

    const response = await SELF.fetch(`${BASE}/stats/github/commits`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ code: 200, data: 0 })
  })

  it('turns an upstream failure into the { code, error } envelope', async () => {
    axiosGet().mockRejectedValue(new Error('Request failed with status code 401'))

    const response = await SELF.fetch(`${BASE}/stats/github/commits`)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      code: 500,
      error: 'Request failed with status code 401',
    })
  })

  it('charsets the error response too, since onError also goes through c.json', async () => {
    axiosGet().mockRejectedValue(new Error('boom'))

    const response = await SELF.fetch(`${BASE}/stats/github/commits`)

    expect(response.headers.get('Content-Type')).toBe('application/json; charset=UTF-8')
  })

  it('falls back to a generic message when the failure carries none', async () => {
    axiosGet().mockRejectedValue(new Error(''))

    const response = await SELF.fetch(`${BASE}/stats/github/commits`)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ code: 500, error: 'Internal Server Error' })
  })
})

describe('GET /stats/github/profile', () => {
  it('serves the mapped profile', async () => {
    axiosGet().mockResolvedValue(
      githubResponse(
        profilePayload({ public_repos: 60, total_private_repos: 5, location: 'Santiago, Chile' }),
      ),
    )

    const response = await SELF.fetch(`${BASE}/stats/github/profile`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      code: 200,
      data: {
        avatar: 'https://avatars.githubusercontent.com/u/20404280?v=4',
        profile_url: 'https://github.com/Im-Fran',
        repos: { public: 60, private: 5, total: 65 },
        followers: 137,
        location: 'Santiago, Chile',
      },
    })
  })

  it('serializes a null location as JSON null rather than dropping the key', async () => {
    axiosGet().mockResolvedValue(githubResponse(profilePayload({ location: null })))

    const body = await readJson<{ data: Record<string, unknown> }>(
      await SELF.fetch(`${BASE}/stats/github/profile`),
    )

    expect('location' in body.data).toBe(true)
    expect(body.data.location).toBeNull()
  })

  it('surfaces the upstream status in the error body on a non-200', async () => {
    axiosGet().mockResolvedValue(githubResponse({ message: 'queued' }, 202, 'Accepted'))

    const response = await SELF.fetch(`${BASE}/stats/github/profile`)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      code: 500,
      error: 'Failed to fetch GitHub profile: 202 Accepted',
    })
  })

  it('turns a transport failure into a 500 envelope', async () => {
    axiosGet().mockRejectedValue(new Error('socket hang up'))

    const response = await SELF.fetch(`${BASE}/stats/github/profile`)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ code: 500, error: 'socket hang up' })
  })
})

describe('GET /stats/github/stars', () => {
  it('serves the total from a single GraphQL page', async () => {
    axiosPost().mockResolvedValue(starsPage([200, 30, 1], LAST_PAGE))

    const response = await SELF.fetch(`${BASE}/stats/github/stars`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ code: 200, data: 231 })
  })

  it('walks every GraphQL page before answering', async () => {
    axiosPost()
      .mockResolvedValueOnce(starsPage([100, 100], { hasNextPage: true, endCursor: 'cursor-2' }))
      .mockResolvedValueOnce(starsPage([25], LAST_PAGE))

    const response = await SELF.fetch(`${BASE}/stats/github/stars`)

    await expect(response.json()).resolves.toEqual({ code: 200, data: 225 })
    expect(axiosPost()).toHaveBeenCalledTimes(2)
    expect(axiosPost().mock.calls[1][1].variables.after).toBe('cursor-2')
  })

  it('answers 0 for an account with no repositories', async () => {
    axiosPost().mockResolvedValue(starsPage([], LAST_PAGE))

    await expect((await SELF.fetch(`${BASE}/stats/github/stars`)).json()).resolves.toEqual({
      code: 200,
      data: 0,
    })
  })

  it('calls the GraphQL API with the token bound to the Worker', async () => {
    axiosPost().mockResolvedValue(starsPage([1], LAST_PAGE))

    await SELF.fetch(`${BASE}/stats/github/stars`)

    expect(axiosPost().mock.calls[0][2].headers.Authorization).toBe(`token ${BOUND_TOKEN}`)
  })

  it('turns a GraphQL failure into a 500 envelope', async () => {
    axiosPost().mockRejectedValue(new Error('GraphQL: Bad credentials'))

    const response = await SELF.fetch(`${BASE}/stats/github/stars`)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      code: 500,
      error: 'GraphQL: Bad credentials',
    })
  })
})
