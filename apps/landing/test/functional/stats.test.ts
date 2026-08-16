import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  axiosGet,
  axiosPost,
  githubResponse,
  graphqlErrorPayload,
  profilePayload,
  readJson,
  resetAxios,
  starsPage,
  withoutKeys,
} from '../helpers/github'

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }))

const BASE = 'https://landing.internal'
const LAST_PAGE = { hasNextPage: false, endCursor: null }

// Injected by `vitest.config.ts`; asserting on it proves `c.env` reaches the GitHub helpers.
const BOUND_TOKEN = 'test-github-token'

const STATS_PATHS = [
  '/stats/github',
  '/stats/github/commits',
  '/stats/github/profile',
  '/stats/github/stars',
]

/** Answers every upstream call, so a route can be reached without caring which one it is. */
const stubEveryUpstreamCall = () => {
  axiosGet().mockImplementation((url: string) =>
    Promise.resolve(
      url.includes('/search/commits')
        ? githubResponse({ total_count: 1 })
        : githubResponse(profilePayload()),
    ),
  )
  axiosPost().mockResolvedValue(starsPage([1], LAST_PAGE))
}

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

  it('advertises nothing that is not routable', async () => {
    stubEveryUpstreamCall()

    const listed = await readJson<{ data: { endpoints: string[] } }>(
      await SELF.fetch(`${BASE}/stats/github`),
    )

    // Without this guard the loop below asserts nothing at all against a handler that returns [].
    expect(listed.data.endpoints.length).toBeGreaterThan(0)

    for (const endpoint of listed.data.endpoints) {
      const response = await SELF.fetch(`${BASE}${endpoint}`)
      expect(response.status, `${endpoint} should be routable`).toBe(200)
    }
  })

  it('advertises every stats route the router serves, not a subset of them', async () => {
    // The other direction, which a routability loop cannot cover: a route added without being added
    // to the list is discoverable nowhere. The OpenAPI document is generated from the router itself,
    // so it stands in for the real route table instead of for another hand-written literal.
    const listed = await readJson<{ data: { endpoints: string[] } }>(
      await SELF.fetch(`${BASE}/stats/github`),
    )
    const spec = await readJson<{ paths: Record<string, unknown> }>(
      await SELF.fetch(`${BASE}/openapi.json`),
    )

    const routed = Object.keys(spec.paths).filter((path) => path.startsWith('/stats/github/'))

    expect(routed.length).toBeGreaterThan(0)
    expect([...listed.data.endpoints].sort()).toEqual([...routed].sort())
  })

  it('answers 404 for an unknown stats endpoint', async () => {
    const response = await SELF.fetch(`${BASE}/stats/github/unknown`)

    expect(response.status).toBe(404)
  })
})

describe('method gating on the stats routes', () => {
  // The parent gateway's CORS allowlist now permits write verbs because of the auth Worker, so a
  // stats route accidentally exposed on one would be reachable from a browser, not just internally.
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('refuses %s on every stats route', async (method) => {
    stubEveryUpstreamCall()

    for (const path of STATS_PATHS) {
      const response = await SELF.fetch(`${BASE}${path}`, { method })
      expect(response.status, `${method} ${path}`).toBe(404)
    }
  })

  it('never reaches GitHub for a refused write verb', async () => {
    stubEveryUpstreamCall()

    for (const path of STATS_PATHS) {
      await SELF.fetch(`${BASE}${path}`, { method: 'DELETE' })
    }

    expect(axiosGet()).not.toHaveBeenCalled()
    expect(axiosPost()).not.toHaveBeenCalled()
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

  // KNOWN BUG (reported, not fixed here): an unguarded `total_count` read becomes `undefined`, and
  // `c.json` drops undefined values, so the client is told 200 and handed a body with no `data` —
  // while the generated spec lists `data` as required. Pinned so the break stops being invisible.
  it('answers 200 with no data key at all when GitHub omits total_count', async () => {
    axiosGet().mockResolvedValue(
      githubResponse({ message: 'You have exceeded a secondary rate limit' }),
    )

    const response = await SELF.fetch(`${BASE}/stats/github/commits`)
    const body = await readJson<Record<string, unknown>>(response)

    expect(response.status).toBe(200)
    expect(body).toEqual({ code: 200 })
    expect('data' in body).toBe(false)
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

  // KNOWN BUG (reported, not fixed here): GitHub omits `total_private_repos` for a token without the
  // `repo` scope. `public + undefined` is NaN, which `JSON.stringify` writes as null, and the
  // undefined `private` key disappears entirely — both fields are required in the generated spec.
  it('drops the private repo count and nulls the total when GitHub omits total_private_repos', async () => {
    axiosGet().mockResolvedValue(
      githubResponse(withoutKeys(profilePayload(), 'total_private_repos')),
    )

    const response = await SELF.fetch(`${BASE}/stats/github/profile`)
    const body = await readJson<{ data: { repos: Record<string, unknown> } }>(response)

    expect(response.status).toBe(200)
    expect('private' in body.data.repos).toBe(false)
    expect(body.data.repos).toEqual({ public: 42, total: null })
  })

  it('breaks its own published schema when the private count is missing', async () => {
    // Ties the bug above to the contract the gateway republishes under /landing/*, reading the
    // requirement off the generated document rather than restating it as a literal here.
    axiosGet().mockResolvedValue(
      githubResponse(withoutKeys(profilePayload(), 'total_private_repos')),
    )

    const body = await readJson<{ data: { repos: Record<string, unknown> } }>(
      await SELF.fetch(`${BASE}/stats/github/profile`),
    )
    const spec = await readJson<any>(await SELF.fetch(`${BASE}/openapi.json`))
    const repos =
      spec.paths['/stats/github/profile'].get.responses['200'].content['application/json'].schema
        .properties.data.properties.repos

    expect(repos.required).toContain('private')
    expect(repos.properties.total.type).toBe('number')
    expect(Object.keys(body.data.repos)).not.toContain('private')
    expect(typeof body.data.repos.total).not.toBe('number')
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

  // The in-band failure channel: GitHub answers bad credentials with a 200, so this is what an
  // expired token actually produces end to end. It must not read as a legitimate "0 stars".
  it('refuses to report 0 when GraphQL reports failure in-band with a null user', async () => {
    axiosPost().mockResolvedValue(graphqlErrorPayload('Bad credentials'))

    const response = await SELF.fetch(`${BASE}/stats/github/stars`)
    const body = await readJson<Record<string, unknown>>(response)

    expect(response.status).toBe(500)
    expect('data' in body).toBe(false)
    expect(body.code).toBe(500)
    // KNOWN BUG (reported, not fixed here): the unguarded dereference means the client is handed a
    // raw TypeError message rather than anything naming the upstream problem.
    expect(body.error).toMatch(/Cannot read properties of null .*repositories/)
  })

  it('does not echo the GraphQL error message GitHub sent, only the dereference failure', async () => {
    axiosPost().mockResolvedValue(graphqlErrorPayload('API rate limit exceeded', 'RATE_LIMITED'))

    const body = await readJson<{ error: string }>(await SELF.fetch(`${BASE}/stats/github/stars`))

    // Documents the diagnosability cost of the bug above: the actionable text never reaches anyone.
    expect(body.error).not.toContain('rate limit')
  })
})

describe('secret handling', () => {
  it('keeps the bound GH_TOKEN out of an error response', async () => {
    // `onError` reflects `err.message` verbatim, and axios hangs the request config — headers and
    // all — off the error it rejects with. Serializing the error rather than its message would put
    // the token straight into the body, so this pins that only the message is used.
    const failure: Error & { config?: unknown } = new Error('Request failed with status code 401')
    failure.config = { headers: { Authorization: `token ${BOUND_TOKEN}` } }
    axiosGet().mockRejectedValue(failure)

    const response = await SELF.fetch(`${BASE}/stats/github/commits`)
    const raw = await response.text()

    expect(response.status).toBe(500)
    expect(raw).not.toContain(BOUND_TOKEN)
    expect(JSON.parse(raw)).toEqual({ code: 500, error: 'Request failed with status code 401' })
  })

  it('drops unmapped upstream fields, so an echoed secret cannot ride the profile out', async () => {
    axiosGet().mockResolvedValue(
      githubResponse(profilePayload({ node_id: `echoed-${BOUND_TOKEN}`, twitter_username: 'x' })),
    )

    const raw = await (await SELF.fetch(`${BASE}/stats/github/profile`)).text()

    expect(raw).not.toContain(BOUND_TOKEN)
    expect(raw).not.toContain('node_id')
    expect(raw).not.toContain('twitter_username')
  })
})
