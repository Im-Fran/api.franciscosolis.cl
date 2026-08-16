import { SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { readJson } from '../helpers/github'

const BASE = 'https://landing.internal'

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
let contentType: string | null

beforeAll(async () => {
  const response = await SELF.fetch(`${BASE}/openapi.json`)
  contentType = response.headers.get('Content-Type')
  document = await readJson<OpenApiDocument>(response)
})

const jsonSchemaFor = (path: string): Record<string, any> => {
  const schema = document.paths[path].get.responses['200'].content?.['application/json'].schema
  if (!schema) throw new Error(`${path} has no documented JSON 200 schema`)
  return schema
}

describe('GET /openapi.json', () => {
  it('is served as JSON with the same charset every other JSON response gets', async () => {
    const response = await SELF.fetch(`${BASE}/openapi.json`)

    expect(response.status).toBe(200)
    expect(contentType).toBe('application/json; charset=UTF-8')
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
    for (const [path, methods] of Object.entries(document.paths)) {
      expect(Object.keys(methods), path).toEqual(['get'])

      const operation = methods.get
      expect(operation.description, path).toBeTruthy()
      expect(operation.responses['200'].description, path).toBeTruthy()
      expect(operation.responses['200'].content?.['application/json'].schema, path).toBeDefined()
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

    expect(Object.keys(body).sort()).toEqual([...schema.required].sort())
    expect(body.code).toBe(schema.properties.code.const)
    expect(Object.keys(body.data).sort()).toEqual([...schema.properties.data.required].sort())
    expect(typeof body.data.message).toBe('string')
  })

  it('serves a stats index payload that matches its own documented schema', async () => {
    const body = await readJson<{ code: number; data: { message: string; endpoints: string[] } }>(
      await SELF.fetch(`${BASE}/stats/github`),
    )
    const schema = jsonSchemaFor('/stats/github')

    expect(Object.keys(body).sort()).toEqual([...schema.required].sort())
    expect(body.code).toBe(schema.properties.code.const)
    expect(Object.keys(body.data).sort()).toEqual([...schema.properties.data.required].sort())
    expect(body.data.endpoints.every((endpoint) => typeof endpoint === 'string')).toBe(true)
  })
})
