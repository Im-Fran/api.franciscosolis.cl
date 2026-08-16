import { HTTPException } from 'hono/http-exception'
import { describe, expect, it } from 'vitest'
import { buildErrorRedirect, OAuthException, RedirectValidationException } from '@/lib/errors'

describe('buildErrorRedirect', () => {
  it('appends the RFC 6749 §4.1.2.1 error parameters', () => {
    const url = new URL(buildErrorRedirect('https://client.test/callback', 'access_denied', 'Not invited'))

    expect(url.origin + url.pathname).toBe('https://client.test/callback')
    expect(url.searchParams.get('error')).toBe('access_denied')
    expect(url.searchParams.get('error_description')).toBe('Not invited')
  })

  it('includes state only when one was recorded', () => {
    const withState = new URL(buildErrorRedirect('https://client.test/cb', 'invalid_request', 'bad', 'xyz'))
    expect(withState.searchParams.get('state')).toBe('xyz')

    for (const absent of [undefined, null, '']) {
      const url = new URL(buildErrorRedirect('https://client.test/cb', 'invalid_request', 'bad', absent))
      expect(url.searchParams.has('state')).toBe(false)
    }
  })

  it('keeps a query string the client registered on its redirect URI', () => {
    const url = new URL(buildErrorRedirect('https://client.test/cb?next=%2Fdashboard', 'server_error', 'boom'))

    expect(url.searchParams.get('next')).toBe('/dashboard')
    expect(url.searchParams.get('error')).toBe('server_error')
  })

  it('overwrites an existing error parameter instead of appending a second one', () => {
    const url = new URL(buildErrorRedirect('https://client.test/cb?error=stale', 'invalid_grant', 'expired'))

    expect(url.searchParams.getAll('error')).toEqual(['invalid_grant'])
  })

  it('percent-encodes a description that would otherwise break the query string', () => {
    const raw = buildErrorRedirect('https://client.test/cb', 'invalid_scope', 'Unsupported scope: a&b c')

    expect(raw).toContain('error_description=Unsupported+scope%3A+a%26b+c')
    expect(new URL(raw).searchParams.get('error_description')).toBe('Unsupported scope: a&b c')
  })

  it('preserves the port and path of the redirect URI', () => {
    const url = new URL(buildErrorRedirect('http://localhost:5173/auth/callback', 'access_denied', 'no'))

    expect(url.host).toBe('localhost:5173')
    expect(url.pathname).toBe('/auth/callback')
  })

  it('refuses to build a redirect out of something that is not an absolute URL', () => {
    expect(() => buildErrorRedirect('/relative', 'invalid_request', 'bad')).toThrow()
  })
})

describe('OAuthException', () => {
  it('carries the OAuth code and description alongside the HTTP status', () => {
    const error = new OAuthException(400, 'invalid_grant', 'The authorization code has expired')

    expect(error.status).toBe(400)
    expect(error.code).toBe('invalid_grant')
    expect(error.description).toBe('The authorization code has expired')
  })

  it('uses the description as the Error message, so an unhandled one still reads well', () => {
    const error = new OAuthException(401, 'invalid_client', 'Unknown or inactive client_id')

    expect(error.message).toBe('Unknown or inactive client_id')
  })

  it('is an HTTPException, which is what lets Hono render it at all', () => {
    const error = new OAuthException(503, 'temporarily_unavailable', 'down')

    expect(error).toBeInstanceOf(HTTPException)
    expect(error).toBeInstanceOf(Error)
  })
})

describe('RedirectValidationException', () => {
  it('is always a 400, because there is no trusted redirect URI to report to', () => {
    const error = new RedirectValidationException('redirect_uri is not registered for this client')

    expect(error.status).toBe(400)
    expect(error.message).toBe('redirect_uri is not registered for this client')
  })

  it('is not an OAuthException, so it is rendered in the { code, error } shape', () => {
    const error = new RedirectValidationException('Unknown or inactive client_id')

    expect(error).toBeInstanceOf(HTTPException)
    expect(error).not.toBeInstanceOf(OAuthException)
  })
})
