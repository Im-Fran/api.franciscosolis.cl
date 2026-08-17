import { describe, expect, it } from 'vitest'
import { escapeHtml, renderErrorPage, renderLoginPage } from '@/lib/login-page'
import type { ProviderOption } from '@/lib/login-page'
import { testEnv } from '../helpers/env'

const env = testEnv()

const providers: ProviderOption[] = [
  { name: 'magic_link', displayName: 'Magic Link', initiation: 'email' },
  { name: 'google', displayName: 'Google', initiation: 'redirect' },
]

const render = (overrides: Partial<Parameters<typeof renderLoginPage>[0]> = {}) =>
  renderLoginPage({
    env,
    handle: 'the-handle',
    applicationName: 'franciscosolis.cl',
    providers,
    loginHint: null,
    ...overrides,
  })

describe('escapeHtml', () => {
  it('neutralises every character that could break out of markup or an attribute', () => {
    expect(escapeHtml(`<script>"'&`)).toBe('&lt;script&gt;&quot;&#39;&amp;')
  })

  it('escapes the ampersand first, so an escape is not double-encoded into a literal', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })

  it('leaves ordinary text alone', () => {
    expect(escapeHtml('Ada Lovelace')).toBe('Ada Lovelace')
  })
})

describe('renderLoginPage', () => {
  it('names the application the user is signing in to', () => {
    expect(render()).toContain('to continue to franciscosolis.cl')
  })

  it('posts the form back to the handle it was given, against the public URL', () => {
    expect(render()).toContain(`action="${env.AUTH_PUBLIC_URL}/oauth/authorize/the-handle/magic-link"`)
  })

  it('links each redirect provider to its own continue endpoint', () => {
    expect(render()).toContain(`href="${env.AUTH_PUBLIC_URL}/oauth/authorize/the-handle/google"`)
    expect(render()).toContain('Continue with Google')
  })

  it('offers only what the deployment actually has configured', () => {
    const emailOnly = render({ providers: [providers[0]] })

    expect(emailOnly).toContain('Email me a sign-in link')
    expect(emailOnly).not.toContain('Continue with Google')
    // With nothing to choose between, the "or" divider would be a divider between one thing.
    expect(emailOnly).not.toContain('<span>or</span>')
  })

  it('prefills the address when the client sent a login hint', () => {
    expect(render({ loginHint: 'ada@example.test' })).toContain('value="ada@example.test"')
  })

  it('escapes an application name, which is operator-supplied text in a page', () => {
    const html = render({ applicationName: '<img src=x onerror=alert(1)>' })

    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('escapes a login hint, which is whatever the caller put in the query string', () => {
    const html = render({ loginHint: '" autofocus onfocus="alert(1)' })

    expect(html).not.toContain('autofocus onfocus="alert(1)"')
    expect(html).toContain('&quot;')
  })

  it('escapes the handle it puts in a URL', () => {
    expect(render({ handle: 'a"b' })).not.toContain('action="https://api.franciscosolis.cl/auth/oauth/authorize/a"b/')
  })

  it('shows an error above the form without dropping the form', () => {
    const html = render({ error: 'A valid email address is required' })

    expect(html).toContain('class="error"')
    expect(html).toContain('A valid email address is required')
    expect(html).toContain('Email me a sign-in link')
  })

  it('replaces the form with the notice once a link has gone out', () => {
    const html = render({ notice: 'a link is on its way' })

    expect(html).toContain('a link is on its way')
    expect(html).not.toContain('Email me a sign-in link')
  })

  it('asks not to be indexed, being a sign-in page reachable by URL', () => {
    expect(render()).toContain('name="robots" content="noindex, nofollow"')
  })

  it('requests no external resource, which the deployment would forbid anyway', () => {
    const html = render()

    expect(html).not.toMatch(/<script\b/)
    expect(html).not.toContain('<link')
    expect(html).not.toMatch(/https?:\/\/(?!api\.franciscosolis\.cl)/)
  })
})

describe('renderErrorPage', () => {
  it('states the failure in the same chrome, with both halves escaped', () => {
    const html = renderErrorPage(env, 'Sign-in failed', '<b>redirect_uri</b> is not registered')

    expect(html).toContain('Sign-in failed')
    expect(html).toContain('&lt;b&gt;redirect_uri&lt;/b&gt;')
    expect(html).not.toContain('<b>redirect_uri</b>')
  })
})
