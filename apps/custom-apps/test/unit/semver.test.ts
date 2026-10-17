import { describe, expect, it } from 'vitest'
import { compareSemver, isSemver, parseSemver } from '@/lib/semver'

describe('semantic versions', () => {
  it('parse leniently, the way a device reports them', () => {
    expect(parseSemver('1.4.0')).toEqual({ major: 1, minor: 4, patch: 0, prerelease: [] })
    expect(parseSemver('v1.4')).toEqual({ major: 1, minor: 4, patch: 0, prerelease: [] })
    expect(parseSemver('2')).toEqual({ major: 2, minor: 0, patch: 0, prerelease: [] })
    expect(parseSemver('1.0.0-rc.2+build.7')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: ['rc', 2] })
    expect(isSemver('1.04.0')).toBe(false)
    expect(isSemver('latest')).toBe(false)
    expect(parseSemver(null)).toBeNull()
  })

  it('order per semver, numerically and with pre-releases first', () => {
    const sorted = ['1.10.0', '1.2.0', '1.0.0', '1.0.0-rc.1', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta.11', '1.0.0-beta.2', '0.9.9'].sort(compareSemver)
    expect(sorted).toEqual(['0.9.9', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.2.0', '1.10.0'])
    expect(compareSemver('v1.4', '1.4.0')).toBe(0)
    expect(compareSemver('1.0.0+a', '1.0.0+b')).toBe(0)
  })

  it('sort what cannot be parsed before everything else', () => {
    expect(compareSemver('garbage', '0.0.1')).toBeLessThan(0)
    expect(compareSemver('0.0.1', null)).toBeGreaterThan(0)
    expect(compareSemver(null, undefined)).toBe(0)
  })
})
