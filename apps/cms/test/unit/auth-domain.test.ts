import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { Env } from '@/env'
import { isAllowedEmail } from '@/middleware/auth'

/** An `Env` carrying just the allowlist, which is all `isAllowedEmail` reads. */
const withDomains = (domains: string) => ({ ...env, CMS_ALLOWED_EMAIL_DOMAINS: domains }) as Env

describe('isAllowedEmail', () => {
  const allowed = withDomains('franciscosolis.cl')

  it('accepts an address on the allowed domain', () => {
    expect(isAllowedEmail(allowed, 'fran@franciscosolis.cl')).toBe(true)
  })

  it('matches the domain case-insensitively', () => {
    expect(isAllowedEmail(allowed, 'Fran@FRANCISCOSOLIS.CL')).toBe(true)
    expect(isAllowedEmail(withDomains('FranciscoSolis.CL'), 'fran@franciscosolis.cl')).toBe(true)
  })

  it('rejects a domain that merely ends with the allowed one', () => {
    // The suffix attack the source calls out: matching on `endsWith` would let this in.
    expect(isAllowedEmail(allowed, 'attacker@notfranciscosolis.cl')).toBe(false)
    expect(isAllowedEmail(allowed, 'attacker@xfranciscosolis.cl')).toBe(false)
  })

  it('rejects a domain that merely starts with the allowed one', () => {
    expect(isAllowedEmail(allowed, 'attacker@franciscosolis.cl.evil.com')).toBe(false)
    expect(isAllowedEmail(allowed, 'attacker@franciscosolis.club')).toBe(false)
  })

  it('rejects a subdomain of the allowed domain', () => {
    // Matching is on the full label, so `mail.franciscosolis.cl` is a different domain.
    expect(isAllowedEmail(allowed, 'fran@mail.franciscosolis.cl')).toBe(false)
  })

  it('rejects the domain smuggled somewhere other than the domain part', () => {
    expect(isAllowedEmail(allowed, 'franciscosolis.cl@evil.com')).toBe(false)
    expect(isAllowedEmail(allowed, 'fran+franciscosolis.cl@evil.com')).toBe(false)
  })

  it('rejects an address with no domain at all', () => {
    expect(isAllowedEmail(allowed, 'fran')).toBe(false)
    expect(isAllowedEmail(allowed, '')).toBe(false)
    expect(isAllowedEmail(allowed, 'fran@')).toBe(false)
  })

  it('takes the second segment, so a second @ cannot shift the domain', () => {
    expect(isAllowedEmail(allowed, 'fran@evil.com@franciscosolis.cl')).toBe(false)
  })

  it('honours a comma-separated allowlist, whitespace and @ prefixes included', () => {
    const multi = withDomains(' @franciscosolis.cl , example.org ')
    expect(isAllowedEmail(multi, 'fran@franciscosolis.cl')).toBe(true)
    expect(isAllowedEmail(multi, 'someone@example.org')).toBe(true)
    expect(isAllowedEmail(multi, 'someone@example.com')).toBe(false)
  })

  it('lets nobody in when the allowlist is empty', () => {
    expect(isAllowedEmail(withDomains(''), 'fran@franciscosolis.cl')).toBe(false)
    expect(isAllowedEmail(withDomains('  ,  '), 'fran@franciscosolis.cl')).toBe(false)
  })

  it('reads the allowlist per call, so a change takes effect immediately', () => {
    expect(isAllowedEmail(withDomains('example.org'), 'fran@franciscosolis.cl')).toBe(false)
    expect(isAllowedEmail(withDomains('franciscosolis.cl'), 'fran@franciscosolis.cl')).toBe(true)
  })
})
