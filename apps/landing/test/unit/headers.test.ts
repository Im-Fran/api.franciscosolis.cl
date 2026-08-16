import { describe, expect, it } from 'vitest'
import githubHeaders from '@/stats/github/headers'

describe('githubHeaders', () => {
  it('sends the token using the `token` scheme GitHub expects', () => {
    expect(githubHeaders('abc123').Authorization).toBe('token abc123')
  })

  it('asks for the versioned GitHub media type', () => {
    expect(githubHeaders('abc123').Accept).toBe('application/vnd.github+json')
  })

  it('always identifies itself, which the GitHub API requires', () => {
    expect(githubHeaders('abc123')['User-Agent']).toBe('FranciscoSolis-Portfolio-Api/1.0')
  })

  it('sends nothing beyond those three headers', () => {
    expect(Object.keys(githubHeaders('abc123')).sort()).toEqual([
      'Accept',
      'Authorization',
      'User-Agent',
    ])
  })

  it('embeds the token verbatim, punctuation included', () => {
    // Fine-grained PATs carry underscores; any re-encoding would make GitHub answer 401.
    expect(githubHeaders('github_pat_11ABCDEF_xyz.789').Authorization).toBe(
      'token github_pat_11ABCDEF_xyz.789',
    )
  })

  it('builds a fresh object per call, so one caller cannot poison the next request', () => {
    const first = githubHeaders('first-token')
    first.Authorization = 'token tampered'

    expect(githubHeaders('second-token').Authorization).toBe('token second-token')
    expect(first.Authorization).toBe('token tampered')
  })

  it('produces no scheme prefix of its own beyond `token`', () => {
    // A `Bearer` prefix is what most APIs want and what GitHub's search API rejects.
    expect(githubHeaders('abc123').Authorization.startsWith('Bearer')).toBe(false)
  })
})
