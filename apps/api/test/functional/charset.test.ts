import { describe, expect, it } from 'vitest'
import { gateway } from '../helpers/gateway'

const contentTypeOf = async (path: string) => (await gateway(path)).headers.get('Content-Type')

/** Asks a stub to answer with a chosen Content-Type, so the middleware's exact-match test is visible. */
const upstreamContentType = (value: string) =>
  `/cms/content-type?value=${encodeURIComponent(value)}`

describe('JSON charset middleware', () => {
  it('declares UTF-8 on the gateway own JSON', async () => {
    expect(await contentTypeOf('/')).toBe('application/json; charset=UTF-8')
  })

  it('declares UTF-8 on the merged OpenAPI document', async () => {
    expect(await contentTypeOf('/openapi.json')).toBe('application/json; charset=UTF-8')
  })

  it.each(['/landing/thing', '/auth/thing', '/cms/thing'])(
    'declares UTF-8 on JSON proxied from %s',
    async (path) => {
      expect(await contentTypeOf(path)).toBe('application/json; charset=UTF-8')
    },
  )

  it('leaves a plain-text 404 alone', async () => {
    expect(await contentTypeOf('/nope')).toBe('text/plain; charset=UTF-8')
  })

  it('leaves a plain-text upstream error alone', async () => {
    const response = await gateway('/landing/boom')

    expect(response.status).toBe(500)
    expect(response.headers.get('Content-Type')).toBe('text/plain;charset=UTF-8')
    await expect(response.text()).resolves.toBe('upstream exploded')
  })

  it('does not touch a JSON media type that is not exactly application/json', async () => {
    expect(await contentTypeOf(upstreamContentType('application/vnd.api+json')))
      .toBe('application/vnd.api+json')
  })

  it('does not overwrite a charset the module already chose', async () => {
    expect(await contentTypeOf(upstreamContentType('application/json; charset=ISO-8859-1')))
      .toBe('application/json; charset=ISO-8859-1')
  })

  it('does not touch a non-JSON media type', async () => {
    expect(await contentTypeOf(upstreamContentType('text/html'))).toBe('text/html')
  })

  it('does not append a second charset when the module already declared UTF-8', async () => {
    expect(await contentTypeOf(upstreamContentType('application/json; charset=UTF-8')))
      .toBe('application/json; charset=UTF-8')
  })

  it('leaves a redirect with no body type alone', async () => {
    const response = await gateway('/auth/redirect', { redirect: 'manual' })

    expect(response.status).toBe(302)
    expect(response.headers.get('Content-Type')).toBeNull()
  })
})
