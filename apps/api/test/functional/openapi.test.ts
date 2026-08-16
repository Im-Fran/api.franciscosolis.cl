import { describe, expect, it } from 'vitest'
import { fetcher, gateway, gatewayWithBindings } from '../helpers/gateway'
import { moduleSpec } from '../helpers/specs'

type Document = {
  openapi: string
  info: { title: string; version: string; description: string }
  paths: Record<string, Record<string, { summary?: string; description?: string; tags?: string[] }>>
  components: { schemas: Record<string, unknown> }
}

const documentFrom = (response: Response) => response.json<Document>()

describe('GET /openapi.json', () => {
  it('answers 200 with a JSON document', async () => {
    const response = await gateway('/openapi.json')

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=UTF-8')
    expect((await documentFrom(response)).openapi).toMatch(/^3\./)
  })

  it('carries the gateway identity, not a module one', async () => {
    const { info } = await documentFrom(await gateway('/openapi.json'))

    expect(info.title).toBe('FranciscoSolis - Rest API')
    expect(info.version).toBe('1.0.0')
    expect(info.description).toContain('franciscosolis.cl')
  })

  it('describes the gateway own status route', async () => {
    const { paths } = await documentFrom(await gateway('/openapi.json'))

    expect(paths['/']?.get).toMatchObject({
      operationId: 'getIndex',
      tags: ['General'],
    })
  })

  it('resolves the status route response schema instead of leaving a bare reference', async () => {
    const document = await documentFrom(await gateway('/openapi.json'))
    const schema = (document.paths['/'] as unknown as {
      get: { responses: Record<string, { content: Record<string, { schema: unknown }> }> }
    }).get.responses['200'].content['application/json'].schema

    expect(schema).toMatchObject({
      type: 'object',
      properties: {
        status: { const: 200 },
        data: {
          type: 'object',
          properties: { message: { type: 'string' }, modules: { type: 'array' } },
        },
      },
    })
  })

  it('mounts every module spec under its own prefix', async () => {
    const { paths } = await documentFrom(await gateway('/openapi.json'))

    expect(Object.keys(paths).sort()).toEqual([
      '/',
      '/auth',
      '/auth/thing',
      '/cms',
      '/cms/thing',
      '/landing',
      '/landing/thing',
    ])
  })

  it('keeps each module operation attached to the module it came from', async () => {
    const { paths } = await documentFrom(await gateway('/openapi.json'))

    for (const module of ['landing', 'auth', 'cms']) {
      expect(paths[`/${module}`]?.get?.summary).toBe(`${module} root`)
      expect(paths[`/${module}/thing`]?.get?.summary).toBe(`${module} thing`)
    }
  })

  it('collapses each module root onto the bare prefix', async () => {
    const { paths } = await documentFrom(await gateway('/openapi.json'))

    for (const module of ['landing', 'auth', 'cms']) {
      expect(paths).not.toHaveProperty([`/${module}/`])
    }
  })

  // The three `app.all('/<module>/*')` routes carry `describeRoute` metadata that never reaches the
  // document; only the merged module specs describe what lives behind a prefix. Reported as a bug.
  it('does not document the wildcard proxy routes themselves', async () => {
    const { paths } = await documentFrom(await gateway('/openapi.json'))

    expect(paths).not.toHaveProperty(['/landing/*'])
    expect(paths).not.toHaveProperty(['/auth/*'])
    expect(paths).not.toHaveProperty(['/cms/*'])
    expect(paths).not.toHaveProperty(['/openapi.json'])
  })

  // A single `components` group survives the merge because every module publishes its schemas
  // under `schemas` and the merge replaces that group wholesale. Reported as a bug.
  it('keeps only one module schema group after the merge', async () => {
    const { components } = await documentFrom(await gateway('/openapi.json'))
    const names = Object.keys(components.schemas)

    expect(names).toHaveLength(1)
    expect(['landingSchema', 'authSchema', 'cmsSchema']).toContain(names[0])
  })
})

describe('GET /openapi.json with a module unavailable', () => {
  it('drops the unreachable module and keeps the rest', async () => {
    const response = await gatewayWithBindings(
      { LANDING: fetcher(() => Promise.reject(new Error('no such Worker'))) },
      '/openapi.json',
    )

    expect(response.status).toBe(200)
    const { paths } = await documentFrom(response)
    expect(Object.keys(paths).sort()).toEqual(['/', '/auth', '/auth/thing', '/cms', '/cms/thing'])
  })

  it('drops a module answering a non-2xx status', async () => {
    const response = await gatewayWithBindings(
      { AUTH: fetcher(() => new Response('service unavailable', { status: 503 })) },
      '/openapi.json',
    )

    expect(response.status).toBe(200)
    expect(Object.keys((await documentFrom(response)).paths)).not.toContain('/auth')
  })

  it('drops a module answering 200 with something that is not a spec', async () => {
    const response = await gatewayWithBindings(
      { CMS: fetcher(() => new Response('<!doctype html>', {
        headers: { 'Content-Type': 'application/json' },
      })) },
      '/openapi.json',
    )

    expect(response.status).toBe(200)
    expect(Object.keys((await documentFrom(response)).paths)).not.toContain('/cms')
  })

  it('still answers with the gateway own routes when every module is down', async () => {
    const down = () => fetcher(() => Promise.reject(new Error('down')))
    const response = await gatewayWithBindings(
      { LANDING: down(), AUTH: down(), CMS: down() },
      '/openapi.json',
    )

    expect(response.status).toBe(200)
    const document = await documentFrom(response)
    expect(Object.keys(document.paths)).toEqual(['/'])
    expect(document.info.title).toBe('FranciscoSolis - Rest API')
  })

  it('asks each module for its spec at /openapi.json, not at the caller path', async () => {
    const asked: string[] = []
    const recording = (module: string) => fetcher((request) => {
      asked.push(new URL(request.url).pathname)
      return Response.json(moduleSpec(module))
    })

    const response = await gatewayWithBindings(
      { LANDING: recording('landing'), AUTH: recording('auth'), CMS: recording('cms') },
      '/openapi.json?ignored=1',
    )

    expect(response.status).toBe(200)
    expect(asked).toEqual(['/openapi.json', '/openapi.json', '/openapi.json'])
  })
})
