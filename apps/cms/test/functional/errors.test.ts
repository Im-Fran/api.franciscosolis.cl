import { SELF, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDatabase, seedEntry } from '../helpers/db'
import { asEditor, mintToken, stubJwks, stubJwksFetch, testKeyPair } from '../helpers/tokens'

/**
 * What the Worker says when something goes wrong that is nobody's request to fix.
 *
 * The rule the tests here defend: a 5xx body is generic. An unexpected error in this Worker is
 * almost always a Drizzle failure, and a Drizzle error message carries the full statement with its
 * bound parameters — which, for `email_messages`, means the body and recipients of an email.
 */

let headers: Record<string, string>

/** Runs `body` with `content_entries` renamed out from under the Worker, then puts it back. */
const withMissingTable = async <T>(body: () => Promise<T>): Promise<T> => {
  await env.DB.exec('ALTER TABLE content_entries RENAME TO content_entries_hidden')
  try {
    return await body()
  } finally {
    await env.DB.exec('ALTER TABLE content_entries_hidden RENAME TO content_entries')
  }
}

beforeAll(async () => {
  headers = await asEditor()
})

beforeEach(clearDatabase)

describe('an unexpected failure', () => {
  it('answers a generic 500 on a public read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await withMissingTable(() => SELF.fetch('https://cms.internal/content/projects'))
    const body = await response.json<{ code: number; error: string }>()
    error.mockRestore()

    expect(response.status).toBe(500)
    expect(body).toEqual({ code: 500, error: 'Internal Server Error' })
  })

  it('leaks neither the statement nor its bound parameters', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await withMissingTable(() =>
      SELF.fetch('https://cms.internal/admin/content/projects', {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'A secret working title', summary: 'Not for the public' }),
      }),
    )
    const text = await response.text()
    error.mockRestore()

    expect(response.status).toBe(500)
    expect(text).not.toContain('A secret working title')
    expect(text).not.toContain('Not for the public')
    expect(text).not.toContain('content_entries')
    expect(text).not.toContain('insert')
  })

  it('logs the real error instead of returning it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await withMissingTable(() => SELF.fetch('https://cms.internal/content/projects'))
    const logged = error.mock.calls[0]
    error.mockRestore()

    // Exactly why the body is generic: the Drizzle error spells out the statement and every
    // bound parameter. That belongs in the observability logs, not in a response.
    expect(logged?.[0]).toBe('unhandled error')
    expect(String(logged?.[1])).toContain('from "content_entries"')
    expect(String(logged?.[1])).toContain('params:')
  })

  it('is still marked no-store', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await withMissingTable(() => SELF.fetch('https://cms.internal/content/projects'))
    error.mockRestore()

    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('leaves the Worker healthy once the cause is gone', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await withMissingTable(() => SELF.fetch('https://cms.internal/content/projects'))
    error.mockRestore()

    await seedEntry({ collection: 'projects', slug: 'recovered' })
    expect((await SELF.fetch('https://cms.internal/content/projects/recovered')).status).toBe(200)
  })
})

describe('a client error', () => {
  it('keeps its own message, unlike a 5xx', async () => {
    const response = await SELF.fetch('https://cms.internal/content/talks')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ code: 404, error: 'Unknown collection: talks' })
  })
})

describe('a non-Error thrown while verifying a token', () => {
  it('is reported without pretending to know what it was', async () => {
    // `describeTokenError` reads `error.name`; anything that is not an Error has none, so it must
    // fall through to a message that still carries no credential.
    const { publicJwk } = await testKeyPair()
    const token = await mintToken()

    // Another URL so the per-isolate cache cannot answer, and a throw that is not an Error. Both
    // are undone in a `finally`: a leftover URL would fail every later test in this file for a
    // reason unrelated to whatever actually broke.
    const original = env.AUTH_JWKS_URL
    env.AUTH_JWKS_URL = 'https://auth.test/string-throw.json'
    stubJwksFetch(async () => {
      throw 'connection reset'
    })

    let response: Response
    let body: { error: string }
    try {
      response = await SELF.fetch('https://cms.internal/admin/me', {
        headers: { Authorization: `Bearer ${token}` },
      })
      body = await response.json<{ error: string }>()
    } finally {
      env.AUTH_JWKS_URL = original
      stubJwks([publicJwk])
    }

    expect(response.status).toBe(401)
    expect(body.error).toBe('Invalid access token: unknown error')
    expect(body.error).not.toContain(token)
  })

  it('recovers once the endpoint behaves again', async () => {
    const response = await SELF.fetch('https://cms.internal/admin/me', { headers })

    expect(response.status).toBe(200)
  })
})
