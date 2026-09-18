import { describe, expect, it } from 'vitest'
import { describeUserAgent } from '@/lib/user-agent'

describe('describeUserAgent', () => {
  it('names the browser and the platform of an ordinary desktop client', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome on macOS')

    expect(
      describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0'),
    ).toBe('Firefox on Windows')
  })

  it('prefers the most specific marker, since every Chromium browser also says Chrome', () => {
    const edge =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'
    const opera =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0'

    expect(describeUserAgent(edge)).toBe('Edge on Windows')
    expect(describeUserAgent(opera)).toBe('Opera on Windows')
  })

  it('reads an iOS browser as the platform it is on, not as the engine it is forced to use', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Chrome on iOS')

    expect(
      describeUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iOS')
  })

  it('reads Android before the Linux it also claims to be', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome on Android')
  })

  it('falls back to whichever half it could recognise', () => {
    expect(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64) curl-ish thing')).toBe('Linux')
    expect(describeUserAgent('Firefox/133.0')).toBe('Firefox')
  })

  it('hands back an unrecognised header rather than hiding the only description there is', () => {
    expect(describeUserAgent('my-cli/2.1')).toBe('my-cli/2.1')
  })

  it('truncates an unrecognised header that would otherwise run across the email', () => {
    const described = describeUserAgent('x'.repeat(400)) as string

    expect(described).toHaveLength(120)
    expect(described.endsWith('…')).toBe(true)
  })

  it('answers null when there was no header at all', () => {
    expect(describeUserAgent(null)).toBeNull()
    expect(describeUserAgent(undefined)).toBeNull()
    expect(describeUserAgent('   ')).toBeNull()
  })
})
