import { describe, expect, it } from 'vitest'
import {
  buildReplyAddress,
  buildTicketUrl,
  generateRoutingKey,
  generateSecret,
  parseReplyAddress,
  sha256,
} from '@/lib/tokens'

describe('generateSecret', () => {
  it('is URL-safe, so it survives being pasted into a link', () => {
    expect(generateSecret()).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('carries 256 bits, which base64url renders in 43 characters', () => {
    expect(generateSecret()).toHaveLength(43)
  })

  it('does not repeat', () => {
    const secrets = new Set(Array.from({ length: 200 }, () => generateSecret()))
    expect(secrets.size).toBe(200)
  })
})

describe('sha256', () => {
  it('is the lowercase hex digest', async () => {
    expect(await sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('is stable, which is what makes the stored hash a lookup key', async () => {
    expect(await sha256('same')).toBe(await sha256('same'))
  })
})

describe('buildTicketUrl', () => {
  it('puts the secret in the fragment, never the query string', () => {
    const url = buildTicketUrl('https://franciscosolis.cl/tickets', 'FS-1042', 'sekrit')
    expect(url).toBe('https://franciscosolis.cl/tickets/FS-1042#k=sekrit')
    // The fragment is the whole point: it is never sent to a server, so the secret stays out of
    // access logs and out of the Referer header of every link the page goes on to render.
    expect(new URL(url).search).toBe('')
  })

  it('does not double the slash when the base has a trailing one', () => {
    expect(buildTicketUrl('https://x.test/tickets/', 'FS-1', 's')).toBe('https://x.test/tickets/FS-1#k=s')
  })
})

describe('generateRoutingKey', () => {
  it('is lowercase hex, so passing through mail infrastructure cannot destroy it', () => {
    const key = generateRoutingKey()
    expect(key).toMatch(/^[a-f0-9]{32}$/)
    // A relay that normalises the local part of an address would silently break a base64url key.
    expect(key).toBe(key.toLowerCase())
  })
})

describe('reply addressing', () => {
  it('round-trips the routing key through a lowercasing relay', () => {
    const key = generateRoutingKey()
    const address = buildReplyAddress('franciscosolis.cl', key)
    expect(address).toBe(`reply+${key}@franciscosolis.cl`)
    expect(parseReplyAddress(address.toUpperCase())).toBe(key)
  })

  it.each([
    ['a plain support address', 'soporte@franciscosolis.cl'],
    ['a different plus tag', 'other+abcdef0123456789@franciscosolis.cl'],
    ['an empty key', 'reply+@franciscosolis.cl'],
    ['a key that is not hex', 'reply+NotHexAtAll@franciscosolis.cl'],
    ['nonsense', 'not an address'],
  ])('returns null for %s', (_label, address) => {
    expect(parseReplyAddress(address)).toBeNull()
  })
})
