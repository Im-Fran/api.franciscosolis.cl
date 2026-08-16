import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getGitHubProfile } from '@/stats/github/profile'
import {
  axiosGet,
  expectedGitHubHeaders,
  githubResponse,
  profilePayload,
  resetAxios,
} from '../helpers/github'

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }))

const TOKEN = 'profile-token'

beforeEach(resetAxios)

describe('getGitHubProfile', () => {
  it("maps GitHub's snake_case payload onto the public shape", async () => {
    axiosGet().mockResolvedValue(githubResponse(profilePayload()))

    await expect(getGitHubProfile({ GH_TOKEN: TOKEN })).resolves.toEqual({
      avatar: 'https://avatars.githubusercontent.com/u/20404280?v=4',
      profile_url: 'https://github.com/Im-Fran',
      repos: { public: 42, private: 8, total: 50 },
      followers: 137,
      location: 'Santiago, Chile',
    })
  })

  it('exposes only the mapped fields, so the raw payload cannot leak', async () => {
    axiosGet().mockResolvedValue(githubResponse(profilePayload()))

    const profile = await getGitHubProfile({ GH_TOKEN: TOKEN })

    expect(Object.keys(profile).sort()).toEqual([
      'avatar',
      'followers',
      'location',
      'profile_url',
      'repos',
    ])
    expect(Object.keys(profile.repos).sort()).toEqual(['private', 'public', 'total'])
  })

  it('adds public and private repositories into the total', async () => {
    axiosGet().mockResolvedValue(
      githubResponse(profilePayload({ public_repos: 111, total_private_repos: 23 })),
    )

    await expect(getGitHubProfile({ GH_TOKEN: TOKEN })).resolves.toMatchObject({
      repos: { public: 111, private: 23, total: 134 },
    })
  })

  it('reports zeroes for an account with no repositories at all', async () => {
    axiosGet().mockResolvedValue(
      githubResponse(profilePayload({ public_repos: 0, total_private_repos: 0, followers: 0 })),
    )

    await expect(getGitHubProfile({ GH_TOKEN: TOKEN })).resolves.toMatchObject({
      repos: { public: 0, private: 0, total: 0 },
      followers: 0,
    })
  })

  it('keeps a missing location null instead of coercing it to an empty string', async () => {
    axiosGet().mockResolvedValue(githubResponse(profilePayload({ location: null })))

    await expect(getGitHubProfile({ GH_TOKEN: TOKEN })).resolves.toMatchObject({ location: null })
  })

  it('requests the account endpoint once with the shared GitHub headers', async () => {
    axiosGet().mockResolvedValue(githubResponse(profilePayload()))

    await getGitHubProfile({ GH_TOKEN: TOKEN })

    expect(axiosGet()).toHaveBeenCalledTimes(1)
    expect(axiosGet()).toHaveBeenCalledWith('https://api.github.com/users/Im-Fran', {
      headers: expectedGitHubHeaders(TOKEN),
    })
  })

  // axios' default `validateStatus` rejects anything outside 2xx, so this guard is what catches the
  // 2xx-but-not-200 answers; 4xx/5xx reach the caller as rejections instead.
  it('throws with the status and statusText when GitHub does not answer 200', async () => {
    axiosGet().mockResolvedValue(githubResponse({ message: 'queued' }, 202, 'Accepted'))

    await expect(getGitHubProfile({ GH_TOKEN: TOKEN })).rejects.toThrowError(
      'Failed to fetch GitHub profile: 202 Accepted',
    )
  })

  it('names whichever status it got, so the message is diagnosable', async () => {
    axiosGet().mockResolvedValue(githubResponse('', 204, 'No Content'))

    await expect(getGitHubProfile({ GH_TOKEN: TOKEN })).rejects.toThrowError(
      'Failed to fetch GitHub profile: 204 No Content',
    )
  })

  it('refuses to map a non-200 body even when it looks like a complete profile', async () => {
    axiosGet().mockResolvedValue(githubResponse(profilePayload(), 206, 'Partial Content'))

    await expect(getGitHubProfile({ GH_TOKEN: TOKEN })).rejects.toThrowError(
      'Failed to fetch GitHub profile: 206 Partial Content',
    )
  })

  it('propagates a failed request untouched', async () => {
    const failure = new Error('socket hang up')
    axiosGet().mockRejectedValue(failure)

    await expect(getGitHubProfile({ GH_TOKEN: TOKEN })).rejects.toBe(failure)
  })
})
