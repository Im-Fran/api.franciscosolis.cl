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
})
