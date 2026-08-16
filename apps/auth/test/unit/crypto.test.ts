import { describe, expect, it } from 'vitest'
import { base64UrlDecode, base64UrlEncode, generateId, randomToken, sha256, timingSafeEqual } from '@/lib/crypto'

describe('base64UrlEncode', () => {
  it('uses the URL-safe alphabet instead of + and /', () => {
    // 0xff 0xff 0xfe is the shortest input that produces both `+` and `/` in standard base64.
    const encoded = base64UrlEncode(new Uint8Array([0xff, 0xff, 0xfe]))

    expect(encoded).toBe('___-')
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
  })

  it('strips the padding a standard base64 encoder would add', () => {
    // One and two leftover bytes are the two cases that need `=` padding in standard base64.
    expect(base64UrlEncode(new Uint8Array([0x66]))).toBe('Zg')
    expect(base64UrlEncode(new Uint8Array([0x66, 0x6f]))).toBe('Zm8')
    expect(base64UrlEncode(new Uint8Array([0x66, 0x6f, 0x6f]))).toBe('Zm9v')
  })

  it('accepts an ArrayBuffer as well as a view over one', () => {
    const bytes = new Uint8Array([1, 2, 3, 250])

    expect(base64UrlEncode(bytes.buffer)).toBe(base64UrlEncode(bytes))
  })

  it('encodes the empty input as the empty string', () => {
    expect(base64UrlEncode(new Uint8Array([]))).toBe('')
  })
})

describe('base64UrlDecode', () => {
  it('restores every byte value, including 0x00 and 0xff', () => {
    const bytes = new Uint8Array(256).map((_, index) => index)

    expect([...base64UrlDecode(base64UrlEncode(bytes))]).toEqual([...bytes])
  })

  it('re-pads inputs of every remainder length', () => {
    for (const length of [1, 2, 3, 4, 5, 31, 32, 33]) {
      const bytes = crypto.getRandomValues(new Uint8Array(length))
      expect([...base64UrlDecode(base64UrlEncode(bytes))]).toEqual([...bytes])
    }
  })

  it('reverses the - and _ substitutions', () => {
    expect([...base64UrlDecode('___-')]).toEqual([0xff, 0xff, 0xfe])
  })

  it('round-trips a 43-character digest, the length every challenge in this Worker has', () => {
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

    expect(base64UrlEncode(base64UrlDecode(challenge))).toBe(challenge)
    expect(base64UrlDecode(challenge)).toHaveLength(32)
  })

  it('decodes the empty string to no bytes', () => {
    expect(base64UrlDecode('')).toHaveLength(0)
  })
})

describe('sha256', () => {
  it('matches the published digest of "abc"', async () => {
    await expect(sha256('abc')).resolves.toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0')
  })

  it('matches the published digest of the empty string', async () => {
    await expect(sha256('')).resolves.toBe('47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU')
  })

  it('hashes as UTF-8, so a multi-byte character is not truncated to one byte', async () => {
    const [accented, plain] = await Promise.all([sha256('é'), sha256('e')])

    expect(accented).not.toBe(plain)
  })

  it('always produces 43 characters, which is what the stored hash columns hold', async () => {
    for (const value of ['', 'a', 'a'.repeat(1000)]) {
      await expect(sha256(value)).resolves.toHaveLength(43)
    }
  })
})

describe('randomToken', () => {
  it('encodes 32 bytes by default, the entropy every one-time token relies on', () => {
    const token = randomToken()

    expect(token).toHaveLength(43)
    expect(base64UrlDecode(token)).toHaveLength(32)
  })

  it('honours a requested byte length', () => {
    expect(base64UrlDecode(randomToken(16))).toHaveLength(16)
    expect(base64UrlDecode(randomToken(64))).toHaveLength(64)
  })

  it('never emits a character outside the URL-safe alphabet', () => {
    for (let i = 0; i < 50; i++) {
      expect(randomToken()).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  it('does not repeat itself', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => randomToken()))

    expect(tokens.size).toBe(500)
  })
})

describe('generateId', () => {
  it('produces distinct UUIDs', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateId()))

    expect(ids.size).toBe(200)
    expect([...ids][0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('timingSafeEqual', () => {
  it('accepts identical strings', () => {
    expect(timingSafeEqual('correct-horse-battery-staple', 'correct-horse-battery-staple')).toBe(true)
    expect(timingSafeEqual('', '')).toBe(true)
  })

  it('rejects same-length strings that differ in one byte', () => {
    expect(timingSafeEqual('abcdef', 'abcdeg')).toBe(false)
    // The differing byte is the first one, which a short-circuiting comparison would find instantly.
    expect(timingSafeEqual('abcdef', 'zbcdef')).toBe(false)
  })

  it('rejects strings of different lengths without throwing on the shorter one', () => {
    expect(timingSafeEqual('abc', 'abcdef')).toBe(false)
    expect(timingSafeEqual('abcdef', 'abc')).toBe(false)
    expect(timingSafeEqual('', 'a')).toBe(false)
  })

  it('rejects a prefix, which is the case a length-only guard would let through', () => {
    expect(timingSafeEqual('secret', 'secret-extra')).toBe(false)
  })

  it('compares UTF-8 bytes, so equal-looking strings of different encodings differ', () => {
    // U+00E9 precomposed vs. "e" + U+0301 combining accent: same rendering, different bytes.
    expect(timingSafeEqual('é', 'é')).toBe(false)
  })
})
