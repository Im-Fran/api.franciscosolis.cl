import { describe, expect, it } from 'vitest'
import { isOriginAllowed, isOriginPattern, isRegisterableOrigin, matchesOrigin } from '@/lib/origins'

const PREVIEW_PATTERN = 'https://*.franciscosolis.workers.dev'

describe('matchesOrigin', () => {
  it('compares a literal registration by exact string', () => {
    expect(matchesOrigin('https://franciscosolis.cl', 'https://franciscosolis.cl')).toBe(true)
    expect(matchesOrigin('https://www.franciscosolis.cl', 'https://franciscosolis.cl')).toBe(false)
  })

  it.each([
    ['a versioned preview', 'https://abc123-franciscosolis.franciscosolis.workers.dev'],
    ['a branch preview', 'https://claude-cors-8980xm-franciscosolis.franciscosolis.workers.dev'],
    ['a plain workers.dev deployment', 'https://auth.franciscosolis.workers.dev'],
    ['a deeper subdomain', 'https://a.b.franciscosolis.workers.dev'],
  ])('accepts %s under a wildcard', (_label, origin) => {
    expect(matchesOrigin(origin, PREVIEW_PATTERN)).toBe(true)
  })

  it.each([
    // Without a dot boundary this is a hostname anyone can register that ends with ours.
    ['a lookalike anchored on no dot', 'https://evilfranciscosolis.workers.dev'],
    ['the bare anchor itself', 'https://franciscosolis.workers.dev'],
    ['another account', 'https://something.else.workers.dev'],
    ['the anchor on a non-default port', 'https://a.franciscosolis.workers.dev:8443'],
    ['the wrong scheme', 'http://a.franciscosolis.workers.dev'],
    // A header is taken verbatim, so an `Origin` carrying a path must not pass by ending with the
    // anchor.
    ['an anchor smuggled into a path', 'https://evil.test/a.franciscosolis.workers.dev'],
    ['an anchor smuggled into userinfo', 'https://a.franciscosolis.workers.dev@evil.test'],
    ['a value that is not a URL', 'null'],
  ])('refuses %s', (_label, origin) => {
    expect(matchesOrigin(origin, PREVIEW_PATTERN)).toBe(false)
  })

  it.each([
    ['a bare TLD', 'https://*.dev'],
    ['a wildcard with nothing under it', 'https://*.'],
    ['a wildcard that is not the leftmost label', 'https://a.*.franciscosolis.workers.dev'],
    ['a pattern with no scheme', '*.franciscosolis.workers.dev'],
    ['a pattern carrying a path', 'https://*.franciscosolis.workers.dev/callback'],
  ])('refuses to read %s as a pattern', (_label, pattern) => {
    expect(matchesOrigin('https://a.franciscosolis.workers.dev', pattern)).toBe(false)
  })

  it('never lets an anchor be smuggled into the path of an Origin', () => {
    expect(matchesOrigin('https://evil.test/a.partner.test', 'https://*.partner.test')).toBe(false)
    expect(matchesOrigin('https://evil.test/a.partner.test/x', 'https://*.partner.test/x')).toBe(false)
  })

  it('keeps a wildcard pinned to whatever port its anchor carries', () => {
    expect(matchesOrigin('https://a.partner.test:8443', 'https://*.partner.test:8443')).toBe(true)
    expect(matchesOrigin('https://a.partner.test:9443', 'https://*.partner.test:8443')).toBe(false)
    expect(matchesOrigin('https://a.partner.test', 'https://*.partner.test:8443')).toBe(false)
  })

  it('refuses a wildcard anchored on a single label, port or not', () => {
    expect(matchesOrigin('http://a.localhost:5173', 'http://*.localhost:5173')).toBe(false)
    expect(matchesOrigin('https://a.internal', 'https://*.internal')).toBe(false)
  })
})

describe('isOriginAllowed', () => {
  const registered = ['https://franciscosolis.cl', PREVIEW_PATTERN]

  it('takes a match from any entry, literal or pattern', () => {
    expect(isOriginAllowed('https://franciscosolis.cl', registered)).toBe(true)
    expect(isOriginAllowed('https://x-franciscosolis.franciscosolis.workers.dev', registered)).toBe(true)
    expect(isOriginAllowed('https://evil.test', registered)).toBe(false)
  })

  it('allows nothing when no client registered anything', () => {
    expect(isOriginAllowed('https://franciscosolis.cl', [])).toBe(false)
  })
})

describe('what may be registered', () => {
  it.each([
    'https://franciscosolis.cl',
    'http://localhost:5173',
    PREVIEW_PATTERN,
    'https://*.franciscosolis.cl',
  ])('accepts %s', (value) => {
    expect(isRegisterableOrigin(value)).toBe(true)
  })

  it.each([
    ['an origin with a path', 'https://franciscosolis.cl/auth'],
    ['a trailing slash', 'https://franciscosolis.cl/'],
    ['a wildcard on a bare TLD', 'https://*.cl'],
    ['a wildcard carrying a path', 'https://*.previews.partner.test/callback'],
    ['something that is not a URL', 'not-a-url'],
  ])('refuses %s', (_label, value) => {
    expect(isRegisterableOrigin(value)).toBe(false)
  })

  it('tells a pattern apart from a literal origin', () => {
    expect(isOriginPattern(PREVIEW_PATTERN)).toBe(true)
    expect(isOriginPattern('https://*.franciscosolis.workers.dev/callback')).toBe(true)
    expect(isOriginPattern('https://franciscosolis.cl')).toBe(false)
  })
})
