import { SELF } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  axiosGet,
  axiosPost,
  githubResponse,
  profilePayload,
  readJson,
  resetAxios,
  starsPage,
} from '../helpers/github'

// The agreement block below drives the upstream-backed routes, which is the only way to compare a
// real payload against the schema the gateway republishes for it.
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }))

const BASE = 'https://landing.internal'
const LAST_PAGE = { hasNextPage: false, endCursor: null }

type Operation = {
  description?: string
  operationId?: string
  tags?: string[]
  responses: Record<
    string,
    { description: string; content?: Record<string, { schema: Record<string, any> }> }
  >
}

type OpenApiDocument = {
  openapi: string
  info: { title: string; version: string; description?: string }
  paths: Record<string, Record<string, Operation>>
}

let document: OpenApiDocument

beforeAll(async () => {
  document = await readJson<OpenApiDocument>(await SELF.fetch(`${BASE}/openapi.json`))
})

beforeEach(resetAxios)

const jsonSchemaFor = (path: string): Record<string, any> => {
  const schema = document.paths[path].get.responses['200'].content?.['application/json'].schema
  if (!schema) throw new Error(`${path} has no documented JSON 200 schema`)
  return schema
}

/**
 * The generated schema is the contract the gateway merges under `/landing/*`, so the check that
 * matters is the live body's own keys against `required` — a handler that stops emitting a declared
 * field, or starts emitting an undeclared one, is exactly the drift this catches.
 */
const expectEnvelopeMatchesSchema = (
  body: Record<string, unknown>,
  schema: Record<string, any>,
) => {
  expect(Object.keys(body).sort()).toEqual([...schema.required].sort())
  expect(body.code).toBe(schema.properties.code.const)
}

describe('GET /openapi.json', () => {
  it('is served as JSON with the same charset every other JSON response gets', async () => {
    const response = await SELF.fetch(`${BASE}/openapi.json`)

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=UTF-8')
  })

  it('is a 3.1 document carrying the configured info block', () => {
    expect(document.openapi).toBe('3.1.0')
    expect(document.info.title).toBe('FranciscoSolis - Landing API')
    expect(document.info.version).toBe('1.0.0')
    expect(document.info.description).toBeTruthy()
  })

  it('documents every route the Worker serves, and nothing it does not', () => {
    expect(Object.keys(document.paths).sort()).toEqual([
      '/',
      '/stats/github',
      '/stats/github/commits',
      '/stats/github/profile',
      '/stats/github/stars',
    ])
  })

  it('leaves the spec route itself out of the spec', () => {
    expect(document.paths['/openapi.json']).toBeUndefined()
  })

  it('describes each documented path as a GET with a described JSON 200', () => {
    const paths = Object.entries(document.paths)

    // Without this the loop below asserts nothing at all against an empty spec.
    expect(paths.length).toBeGreaterThan(0)

    for (const [path, methods] of paths) {
      expect(Object.keys(methods), path).toEqual(['get'])
      expect(methods.get.description, path).toBeTruthy()
      expect(methods.get.responses['200'].description, path).toBeTruthy()
    }
  })

  it('gives every operation a unique id, which the gateway needs when it merges specs', () => {
    const ids = Object.values(document.paths).map((methods) => methods.get.operationId)

    expect(ids).toContain('getStatsGithubCommits')
    expect(ids.filter(Boolean)).toHaveLength(ids.length)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('groups the routes under the General and GitHub tags', () => {
    expect(document.paths['/'].get.tags).toEqual(['General'])
    for (const path of ['/stats/github', '/stats/github/commits', '/stats/github/profile', '/stats/github/stars']) {
      expect(document.paths[path].get.tags, path).toEqual(['GitHub'])
    }
  })
})

describe('the generated response schemas', () => {
  it('pins the numeric payload of the commits and stars endpoints', () => {
    for (const path of ['/stats/github/commits', '/stats/github/stars']) {
      expect(jsonSchemaFor(path), path).toEqual({
        type: 'object',
        properties: { code: { const: 200 }, data: { type: 'number' } },
        required: ['code', 'data'],
      })
    }
  })

  it('pins the profile shape, repo arithmetic and nullable location included', () => {
    const data = jsonSchemaFor('/stats/github/profile').properties.data

    expect(data.required).toEqual(['avatar', 'profile_url', 'repos', 'followers', 'location'])
    expect(data.properties.repos).toEqual({
      type: 'object',
      properties: {
        public: { type: 'number' },
        private: { type: 'number' },
        total: { type: 'number' },
      },
      required: ['public', 'private', 'total'],
    })
    expect(data.properties.location).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    })
  })

  it('pins the endpoint list as an array of strings', () => {
    const data = jsonSchemaFor('/stats/github').properties.data

    expect(data.properties.endpoints).toEqual({ type: 'array', items: { type: 'string' } })
  })
})

describe('spec and runtime agreement', () => {
  it('serves a root payload that matches its own documented schema', async () => {
    const body = await readJson<{ code: number; data: { message: string } }>(
      await SELF.fetch(`${BASE}/`),
    )
    const schema = jsonSchemaFor('/')

    expectEnvelopeMatchesSchema(body, schema)
    expect(Object.keys(body.data).sort()).toEqual([...schema.properties.data.required].sort())
    expect(typeof body.data.message).toBe('string')
  })

  it('serves a stats index payload that matches its own documented schema', async () => {
    const body = await readJson<{ code: number; data: { message: string; endpoints: string[] } }>(
      await SELF.fetch(`${BASE}/stats/github`),
    )
    const schema = jsonSchemaFor('/stats/github')

    expectEnvelopeMatchesSchema(body, schema)
    expect(Object.keys(body.data).sort()).toEqual([...schema.properties.data.required].sort())
    expect(body.data.endpoints.every((endpoint) => typeof endpoint === 'string')).toBe(true)
  })

  // The three routes below derive their payload from upstream data, which makes them the only ones
  // that can drift from the spec without anyone editing a handler — a renamed GitHub field is
  // enough. They need axios stubbed, which is why they were previously left out of this block.
  it('serves a commits payload that matches its own documented schema', async () => {
    axiosGet().mockResolvedValue(githubResponse({ total_count: 12431 }))
    const schema = jsonSchemaFor('/stats/github/commits')

    const body = await readJson<{ code: number; data: unknown }>(
      await SELF.fetch(`${BASE}/stats/github/commits`),
    )

    expectEnvelopeMatchesSchema(body, schema)
    expect(typeof body.data).toBe(schema.properties.data.type)
  })

  it('serves a stars payload that matches its own documented schema, pagination included', async () => {
    axiosPost()
      .mockResolvedValueOnce(starsPage([120, 3], { hasNextPage: true, endCursor: 'c1' }))
      .mockResolvedValueOnce(starsPage([8], LAST_PAGE))
    const schema = jsonSchemaFor('/stats/github/stars')

    const body = await readJson<{ code: number; data: unknown }>(
      await SELF.fetch(`${BASE}/stats/github/stars`),
    )

    expectEnvelopeMatchesSchema(body, schema)
    expect(typeof body.data).toBe(schema.properties.data.type)
    expect(body.data).toBe(131)
  })

  it('serves a profile payload that matches its own documented schema, nested repos included', async () => {
    axiosGet().mockResolvedValue(githubResponse(profilePayload()))
    const schema = jsonSchemaFor('/stats/github/profile')

    const body = await readJson<{ code: number; data: Record<string, any> }>(
      await SELF.fetch(`${BASE}/stats/github/profile`),
    )

    expectEnvelopeMatchesSchema(body, schema)
    expect(Object.keys(body.data).sort()).toEqual([...schema.properties.data.required].sort())
    // This nested comparison is the one that turns red on an upstream payload missing
    // `total_private_repos`; see the characterization test in `stats.test.ts` for that case.
    expect(Object.keys(body.data.repos).sort()).toEqual(
      [...schema.properties.data.properties.repos.required].sort(),
    )
    for (const [field, value] of Object.entries(body.data.repos)) {
      expect(typeof value, `repos.${field}`).toBe('number')
    }
  })

  it('serves a profile location that matches the nullable branch of its schema', async () => {
    axiosGet().mockResolvedValue(githubResponse(profilePayload({ location: null })))
    const allowed = jsonSchemaFor('/stats/github/profile').properties.data.properties.location.anyOf

    const body = await readJson<{ data: { location: unknown } }>(
      await SELF.fetch(`${BASE}/stats/github/profile`),
    )

    expect(body.data.location).toBeNull()
    expect(allowed).toContainEqual({ type: 'null' })
  })
})
