import { describe, expect, it } from 'vitest'
import { buildReplyAddress, buildTicketUrl, generateSecret, parseReplyAddress, sha256 } from '@/lib/tokens'

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

describe('reply addressing', () => {
  it('round-trips the routing key', () => {
    const address = buildReplyAddress('reply.franciscosolis.cl', 'abc-123_XYZ')
    expect(address).toBe('reply+abc-123_XYZ@reply.franciscosolis.cl')
    expect(parseReplyAddress(address)).toBe('abc-123_xyz')
  })

  it.each([
    ['a plain support address', 'soporte@franciscosolis.cl'],
    ['a different plus tag', 'other+abc@franciscosolis.cl'],
    ['an empty key', 'reply+@franciscosolis.cl'],
    ['nonsense', 'not an address'],
  ])('returns null for %s', (_label, address) => {
    expect(parseReplyAddress(address)).toBeNull()
  })
})
