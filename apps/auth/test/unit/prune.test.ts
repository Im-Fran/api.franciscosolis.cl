import { describe, expect, it } from 'vitest'
import { deviceOf, hasRules, networkOf, selectSessionsToPrune, type PrunableSession } from '@/lib/prune'

const NOW = new Date('2026-09-01T12:00:00.000Z')
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)

const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36'
const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'

const session = (overrides: Partial<PrunableSession> = {}): PrunableSession => ({
  id: crypto.randomUUID(),
  applicationId: 'franciscosolis-web',
  provider: 'magic_link',
  ip: '200.1.2.3',
  userAgent: CHROME_MAC,
  country: 'CL',
  city: 'Santiago',
  lastSeenAt: NOW,
  createdAt: NOW,
  revokedAt: null,
  ...overrides,
})

const current = session({ id: 'current' })

const prune = (sessions: PrunableSession[], rules: Parameters<typeof selectSessionsToPrune>[0]['rules'], extra = {}) =>
  selectSessionsToPrune({ sessions, current, rules, now: NOW, ...extra }).map((row) => row.id)

describe('networkOf', () => {
  it('keeps the /24 of an IPv4 address', () => {
    expect(networkOf('200.1.2.3')).toBe('200.1.2')
    expect(networkOf('200.1.2.250')).toBe('200.1.2')
  })

  it('keeps the /48 of an IPv6 address, however it was written', () => {
    expect(networkOf('2001:db8::1')).toBe('2001:db8:0')
    expect(networkOf('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8:0')
    expect(networkOf('2001:db8:abcd:1::1')).toBe('2001:db8:abcd')
  })

  it('answers null for anything that does not parse', () => {
    for (const value of [null, '', '  ', 'not-an-ip', '1.2.3', '1.2.3.999', '2001:db8::1::2', 'gggg::1']) {
      expect(networkOf(value)).toBeNull()
    }
  })
})

describe('deviceOf', () => {
  it('collapses a user agent to its browser and platform, ignoring versions', () => {
    expect(deviceOf(CHROME_MAC)).toBe('chrome/macos')
    expect(deviceOf(CHROME_MAC.replace('141.0.0.0', '999.0.0.0'))).toBe('chrome/macos')
    expect(deviceOf(SAFARI_IOS)).toBe('safari/ios')
  })

  it('falls back to the raw string when neither family is recognised', () => {
    expect(deviceOf('curl/8.4.0')).toBe('curl/8.4.0')
    expect(deviceOf(null)).toBeNull()
  })
})

describe('hasRules', () => {
  it('is false for an empty selection and for one that only switched rules off', () => {
    expect(hasRules({})).toBe(false)
    expect(hasRules({ otherCountries: false, otherDevices: false })).toBe(false)
  })

  it('is true as soon as one rule carries a value', () => {
    expect(hasRules({ inactiveForDays: 30 })).toBe(true)
    expect(hasRules({ otherNetworks: true })).toBe(true)
  })
})

describe('selectSessionsToPrune', () => {
  it('matches nothing when no rule was selected', () => {
    expect(prune([session({ id: 'a', country: 'DE' })], {})).toEqual([])
  })

  it('never touches the current session, however well it matches', () => {
    expect(prune([current], { inactiveForDays: 1, olderThanDays: 1 })).toEqual([])
  })

  it('leaves already revoked sessions out', () => {
    const revoked = session({ id: 'revoked', country: 'DE', revokedAt: daysAgo(1) })
    expect(prune([revoked], { otherCountries: true })).toEqual([])
  })

  it('closes sessions idle for longer than the given days, counting from last activity', () => {
    const idle = session({ id: 'idle', lastSeenAt: daysAgo(40) })
    const active = session({ id: 'active', lastSeenAt: daysAgo(2) })
    const exact = session({ id: 'exact', lastSeenAt: daysAgo(30) })

    expect(prune([idle, active, exact], { inactiveForDays: 30 })).toEqual(['idle', 'exact'])
  })

  it('closes sessions opened longer ago than the given days, however active they are', () => {
    const old = session({ id: 'old', createdAt: daysAgo(400), lastSeenAt: NOW })
    const fresh = session({ id: 'fresh', createdAt: daysAgo(10) })

    expect(prune([old, fresh], { olderThanDays: 365 })).toEqual(['old'])
  })

  it('closes sessions from another country and keeps the ones from this one', () => {
    const abroad = session({ id: 'abroad', country: 'DE', city: 'Berlin' })
    const home = session({ id: 'home', country: 'CL' })

    expect(prune([abroad, home], { otherCountries: true })).toEqual(['abroad'])
  })

  it('closes sessions outside the current network but not another address inside it', () => {
    const elsewhere = session({ id: 'elsewhere', ip: '45.9.9.9' })
    const neighbour = session({ id: 'neighbour', ip: '200.1.2.77' })

    expect(prune([elsewhere, neighbour], { otherNetworks: true })).toEqual(['elsewhere'])
  })

  it('closes sessions on another device and keeps the same browser on a new version', () => {
    const phone = session({ id: 'phone', userAgent: SAFARI_IOS })
    const sameBrowser = session({ id: 'same', userAgent: CHROME_MAC.replace('141.0.0.0', '150.0.0.0') })

    expect(prune([phone, sameBrowser], { otherDevices: true })).toEqual(['phone'])
  })

  it('never matches a session missing the field the rule reads', () => {
    const noLocation = session({ id: 'no-location', country: null, city: null })
    const noIp = session({ id: 'no-ip', ip: null })
    const noAgent = session({ id: 'no-agent', userAgent: null })

    expect(prune([noLocation, noIp, noAgent], { otherCountries: true, otherNetworks: true, otherDevices: true }))
      .toEqual([])
  })

  it('cannot judge a location rule when the current session has none either', () => {
    const abroad = session({ id: 'abroad', country: 'DE' })
    const placeless = { ...current, country: null }

    expect(selectSessionsToPrune({ sessions: [abroad], current: placeless, rules: { otherCountries: true }, now: NOW }))
      .toEqual([])
  })

  it('takes any rule under `any` and every rule under `all`', () => {
    const oldAbroad = session({ id: 'old-abroad', country: 'DE', lastSeenAt: daysAgo(90) })
    const oldHere = session({ id: 'old-here', country: 'CL', lastSeenAt: daysAgo(90) })
    const freshAbroad = session({ id: 'fresh-abroad', country: 'DE', lastSeenAt: NOW })
    const rules = { inactiveForDays: 30, otherCountries: true }

    expect(prune([oldAbroad, oldHere, freshAbroad], rules)).toEqual(['old-abroad', 'old-here', 'fresh-abroad'])
    expect(prune([oldAbroad, oldHere, freshAbroad], rules, { match: 'all' })).toEqual(['old-abroad'])
  })

  it('under `all`, ignores a rule it cannot judge rather than failing the session', () => {
    const oldPlaceless = session({ id: 'old-placeless', country: null, lastSeenAt: daysAgo(90) })

    expect(prune([oldPlaceless], { inactiveForDays: 30, otherCountries: true }, { match: 'all' }))
      .toEqual(['old-placeless'])
  })

  it('narrows by application and by provider before any rule is considered', () => {
    const web = session({ id: 'web', applicationId: 'franciscosolis-web', country: 'DE' })
    const cms = session({ id: 'cms', applicationId: 'franciscosolis-cms', country: 'DE' })
    const google = session({ id: 'google', provider: 'google', country: 'DE' })

    expect(prune([web, cms, google], { otherCountries: true }, { scope: { applications: ['franciscosolis-cms'] } }))
      .toEqual(['cms'])
    expect(prune([web, cms, google], { otherCountries: true }, { scope: { providers: ['google'] } }))
      .toEqual(['google'])
    // An empty list is "no filter", not "nothing passes".
    expect(prune([web, cms, google], { otherCountries: true }, { scope: { applications: [], providers: [] } }))
      .toEqual(['web', 'cms', 'google'])
  })
})
