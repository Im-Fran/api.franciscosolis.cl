import { describe, expect, it } from 'vitest'
import { echoOf, gateway } from '../helpers/gateway'

type RootPayload = {
  status: number
  data: { message: string; modules: string[] }
}

describe('GET /', () => {
  it('reports the gateway is up and lists its modules', async () => {
    const response = await gateway('/')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: 200,
      data: { message: '¡Hello, API!', modules: ['landing', 'auth', 'cms'] },
    })
  })

  it('sends the non-ASCII greeting as UTF-8 bytes', async () => {
    const response = await gateway('/')
    const bytes = new Uint8Array(await response.arrayBuffer())

    // `¡` is C2 A1 in UTF-8 and a single 0xA1 byte in Latin-1; the declared charset is what stops a
    // client from picking the wrong one.
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=UTF-8')
    expect(Array.from(bytes.slice(0, 2))).not.toEqual([0xa1, 0x48])
    expect(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)).toContain('¡Hello, API!')
  })

  it('advertises exactly the modules that are actually proxied', async () => {
    const response = await gateway('/')
    const { data } = await response.json<RootPayload>()

    for (const module of data.modules) {
      const echoed = await echoOf(await gateway(`/${module}/probe`))
      expect(echoed.module).toBe(module)
      expect(echoed.pathname).toBe('/probe')
    }
  })
})

describe('routing misses', () => {
  it.each(['/nope', '/landingx', '/authorize', '/cmsx', '/a/b/c', '/openapi.yaml'])(
    'answers 404 for %s',
    async (path) => {
      const response = await gateway(path)

      expect(response.status).toBe(404)
      expect(response.headers.get('Content-Type')).toBe('text/plain; charset=UTF-8')
      await expect(response.text()).resolves.toBe('404 Not Found')
    },
  )

  it.each(['POST', 'PATCH', 'DELETE'])('answers 404 for %s / — only GET is registered', async (method) => {
    const response = await gateway('/', { method })

    expect(response.status).toBe(404)
  })

  it('answers 404 for POST /openapi.json', async () => {
    const response = await gateway('/openapi.json', { method: 'POST' })

    expect(response.status).toBe(404)
  })

  it('does not route a path that merely starts with a module name', async () => {
    // `/landingx` must not be rewritten to `/x` and forwarded; the wildcard needs the separator.
    const response = await gateway('/landingx')

    expect(response.status).toBe(404)
    expect(response.headers.get('X-Stub-Module')).toBeNull()
  })
})
