import { describe, expect, it, vi } from 'vitest'
import { mergeRemoteSpecs } from '@/openapi'
import type { RemoteComponent } from '@/openapi'
import {
  asRecord,
  gatewaySpec,
  moduleSpec,
  rejecting,
  serving,
  servingRaw,
  throwing,
} from '../helpers/specs'

describe('mergeRemoteSpecs', () => {
  describe('mounting remote paths', () => {
    it('mounts every remote path under the prefix', async () => {
      const spec = gatewaySpec()

      await mergeRemoteSpecs(spec, [{ prefix: '/landing', fetchSpec: serving(moduleSpec('landing')) }])

      expect(Object.keys(asRecord(spec).paths)).toEqual(['/', '/landing', '/landing/thing'])
      expect(asRecord(spec).paths['/landing/thing']).toEqual({ get: { summary: 'landing thing' } })
    })

    it('collapses a remote root path onto the bare prefix', async () => {
      const spec = gatewaySpec()

      await mergeRemoteSpecs(spec, [{ prefix: '/landing', fetchSpec: serving(moduleSpec('landing')) }])

      // `/landing`, not `/landing/` — the latter is a different path to OpenAPI tooling.
      expect(asRecord(spec).paths).toHaveProperty(['/landing'], { get: { summary: 'landing root' } })
      expect(asRecord(spec).paths).not.toHaveProperty(['/landing/'])
    })

    it('keeps the gateway paths it was handed', async () => {
      const spec = gatewaySpec()

      await mergeRemoteSpecs(spec, [{ prefix: '/cms', fetchSpec: serving(moduleSpec('cms')) }])

      expect(asRecord(spec).paths['/']).toEqual({ get: { operationId: 'getIndex' } })
    })

    it('preserves deeply nested and parameterized remote paths verbatim under the prefix', async () => {
      const spec = gatewaySpec()

      await mergeRemoteSpecs(spec, [{
        prefix: '/auth',
        fetchSpec: serving({
          paths: {
            '/.well-known/jwks.json': { get: { summary: 'jwks' } },
            '/admin/users/{id}': { patch: { summary: 'update user' } },
          },
        }),
      }])

      expect(Object.keys(asRecord(spec).paths)).toEqual([
        '/',
        '/auth/.well-known/jwks.json',
        '/auth/admin/users/{id}',
      ])
    })

    it('lets a remote path win over a gateway path it collides with', async () => {
      const spec = gatewaySpec()
      asRecord(spec).paths['/cms/thing'] = { get: { summary: 'gateway placeholder' } }

      await mergeRemoteSpecs(spec, [{ prefix: '/cms', fetchSpec: serving(moduleSpec('cms')) }])

      expect(asRecord(spec).paths['/cms/thing']).toEqual({ get: { summary: 'cms thing' } })
    })

    it('merges nothing but stays quiet when the remote spec carries no paths', async () => {
      const spec = gatewaySpec()

      await mergeRemoteSpecs(spec, [{ prefix: '/landing', fetchSpec: serving({ openapi: '3.1.0' }) }])

      expect(Object.keys(asRecord(spec).paths)).toEqual(['/'])
    })

    it('mounts nothing for an empty component list', async () => {
      const spec = gatewaySpec()
      const before = structuredClone(asRecord(spec))

      await mergeRemoteSpecs(spec, [])

      expect(asRecord(spec)).toEqual(before)
    })
  })

  describe('merging components', () => {
    it('brings a remote component group across', async () => {
      const spec = gatewaySpec()

      await mergeRemoteSpecs(spec, [{
        prefix: '/auth',
        fetchSpec: serving({ components: { securitySchemes: { bearer: { type: 'http' } } } }),
      }])

      expect(asRecord(spec).components).toEqual({
        schemas: { GatewayStatus: { type: 'object' } },
        securitySchemes: { bearer: { type: 'http' } },
      })
    })

    // Pins current behaviour, which is a shallow `Object.assign`: a remote `components.schemas`
    // replaces the gateway's whole `schemas` group rather than being merged into it. Reported as a
    // bug rather than fixed here.
    it('replaces a whole component group instead of merging into it', async () => {
      const spec = gatewaySpec()

      await mergeRemoteSpecs(spec, [{ prefix: '/landing', fetchSpec: serving(moduleSpec('landing')) }])

      expect(asRecord(spec).components).toEqual({ schemas: { landingSchema: { type: 'object' } } })
      expect(asRecord(spec).components?.schemas).not.toHaveProperty('GatewayStatus')
    })

    it('leaves components untouched when the remote spec has none', async () => {
      const spec = gatewaySpec()

      await mergeRemoteSpecs(spec, [{ prefix: '/landing', fetchSpec: serving({ paths: { '/x': {} } }) }])

      expect(asRecord(spec).components).toEqual({ schemas: { GatewayStatus: { type: 'object' } } })
    })

    it('tolerates a remote spec whose components field is null', async () => {
      const spec = gatewaySpec()

      await mergeRemoteSpecs(spec, [{
        prefix: '/landing',
        fetchSpec: serving({ paths: { '/x': { get: { summary: 'x' } } }, components: null }),
      }])

      expect(Object.keys(asRecord(spec).paths)).toEqual(['/', '/landing/x'])
      expect(asRecord(spec).components).toEqual({ schemas: { GatewayStatus: { type: 'object' } } })
    })

    /**
     * The consequence of the shallow `Object.assign`, made deterministic: two modules that both
     * publish under `components.schemas` do not merge, the later answer replaces the earlier group
     * outright. Their paths are unaffected, which is why the merged document can look complete
     * while half its `$ref` targets are gone.
     */
    it('lets the module that answers last replace the shared component group', async () => {
      const spec = gatewaySpec()
      const slow = Promise.withResolvers<Response>()

      const merged = mergeRemoteSpecs(spec, [
        { prefix: '/landing', fetchSpec: () => slow.promise },
        { prefix: '/auth', fetchSpec: serving(moduleSpec('auth')) },
      ])

      // A macrotask lets auth finish its whole merge before landing answers, so the order the two
      // write in is fixed rather than a race.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(asRecord(spec).components).toEqual({ schemas: { authSchema: { type: 'object' } } })

      slow.resolve(Response.json(moduleSpec('landing')))
      await merged

      expect(asRecord(spec).components).toEqual({ schemas: { landingSchema: { type: 'object' } } })
      expect(Object.keys(asRecord(spec).paths).sort()).toEqual([
        '/',
        '/auth',
        '/auth/thing',
        '/landing',
        '/landing/thing',
      ])
    })

    it('still merges paths when the target spec has no components object to assign into', async () => {
      const spec = gatewaySpec()
      delete (asRecord(spec) as { components?: unknown }).components

      await mergeRemoteSpecs(spec, [{ prefix: '/landing', fetchSpec: serving(moduleSpec('landing')) }])

      // The component copy throws and is swallowed, but the paths were already in by then.
      expect(Object.keys(asRecord(spec).paths)).toEqual(['/', '/landing', '/landing/thing'])
      expect(asRecord(spec).components).toBeUndefined()
    })
  })

  describe('skipping a module that cannot be read', () => {
    it.each([
      ['404', 404],
      ['500', 500],
      ['503', 503],
      ['301', 301],
    ])('skips a module answering %s', async (_label, status) => {
      const spec = gatewaySpec()

      await mergeRemoteSpecs(spec, [{
        prefix: '/landing',
        fetchSpec: serving(moduleSpec('landing'), { status }),
      }])

      expect(Object.keys(asRecord(spec).paths)).toEqual(['/'])
      expect(asRecord(spec).components).toEqual({ schemas: { GatewayStatus: { type: 'object' } } })
    })

    it('skips a 2xx module whose body is not valid JSON', async () => {
      const spec = gatewaySpec()

      await mergeRemoteSpecs(spec, [{
        prefix: '/landing',
        fetchSpec: servingRaw('<!doctype html><h1>oops</h1>', {
          headers: { 'Content-Type': 'application/json' },
        }),
      }])

      expect(Object.keys(asRecord(spec).paths)).toEqual(['/'])
    })

    it('skips a 204 with no body at all', async () => {
      const spec = gatewaySpec()

      await mergeRemoteSpecs(spec, [{ prefix: '/landing', fetchSpec: servingRaw(null, { status: 204 }) }])

      expect(Object.keys(asRecord(spec).paths)).toEqual(['/'])
    })

    it('skips a module whose JSON body is null rather than an object', async () => {
      const spec = gatewaySpec()

      await mergeRemoteSpecs(spec, [{ prefix: '/landing', fetchSpec: serving(null) }])

      expect(Object.keys(asRecord(spec).paths)).toEqual(['/'])
    })

    it('skips a module whose fetch rejects', async () => {
      const spec = gatewaySpec()

      await mergeRemoteSpecs(spec, [{ prefix: '/landing', fetchSpec: rejecting('no such Worker') }])

      expect(Object.keys(asRecord(spec).paths)).toEqual(['/'])
    })

    it('skips a module whose fetch throws synchronously', async () => {
      const spec = gatewaySpec()

      await mergeRemoteSpecs(spec, [{ prefix: '/landing', fetchSpec: throwing('binding is undefined') }])

      expect(Object.keys(asRecord(spec).paths)).toEqual(['/'])
    })

    it('never rejects, whatever the modules do', async () => {
      const spec = gatewaySpec()

      await expect(mergeRemoteSpecs(spec, [
        { prefix: '/landing', fetchSpec: rejecting('down') },
        { prefix: '/auth', fetchSpec: throwing('down') },
        { prefix: '/cms', fetchSpec: servingRaw('not json') },
      ])).resolves.toBeUndefined()
    })
  })

  describe('isolating one module from another', () => {
    it('merges the healthy modules around a broken one', async () => {
      const spec = gatewaySpec()

      await mergeRemoteSpecs(spec, [
        { prefix: '/landing', fetchSpec: rejecting('landing is down') },
        { prefix: '/auth', fetchSpec: serving(moduleSpec('auth')) },
        { prefix: '/cms', fetchSpec: serving(moduleSpec('cms')) },
      ])

      const paths = Object.keys(asRecord(spec).paths)
      expect(paths).toEqual(expect.arrayContaining(['/auth', '/auth/thing', '/cms', '/cms/thing']))
      expect(paths).not.toEqual(expect.arrayContaining(['/landing', '/landing/thing']))
    })

    it('merges the modules that follow a broken first one', async () => {
      const spec = gatewaySpec()

      await mergeRemoteSpecs(spec, [
        { prefix: '/landing', fetchSpec: throwing('landing is down') },
        { prefix: '/auth', fetchSpec: serving(moduleSpec('auth')) },
      ])

      expect(Object.keys(asRecord(spec).paths)).toEqual(expect.arrayContaining(['/auth', '/auth/thing']))
    })

    it('asks every module exactly once, even when the first one fails', async () => {
      const spec = gatewaySpec()
      const components: RemoteComponent[] = [
        { prefix: '/landing', fetchSpec: vi.fn(rejecting('down')) },
        { prefix: '/auth', fetchSpec: vi.fn(serving(moduleSpec('auth'))) },
        { prefix: '/cms', fetchSpec: vi.fn(serving(moduleSpec('cms'))) },
      ]

      await mergeRemoteSpecs(spec, components)

      for (const { fetchSpec } of components) {
        expect(fetchSpec).toHaveBeenCalledTimes(1)
      }
    })

    it('does not wait for one module before starting the next', async () => {
      const spec = gatewaySpec()
      const started: string[] = []
      const gate = Promise.withResolvers<void>()

      const merged = mergeRemoteSpecs(spec, [
        {
          prefix: '/landing',
          fetchSpec: async () => {
            started.push('landing')
            await gate.promise
            return Response.json(moduleSpec('landing'))
          },
        },
        {
          prefix: '/auth',
          fetchSpec: () => {
            started.push('auth')
            return Promise.resolve(Response.json(moduleSpec('auth')))
          },
        },
      ])

      expect(started).toEqual(['landing', 'auth'])
      gate.resolve()
      await merged

      expect(Object.keys(asRecord(spec).paths)).toEqual(expect.arrayContaining(['/landing', '/auth']))
    })
  })
})
