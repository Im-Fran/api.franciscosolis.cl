import { SELF } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { applications, auditLogs } from '@/db/schema'
import { sha256 } from '@/lib/crypto'
import { createApplication, createRole, db, SEED, signIn } from '../helpers/db'
import { RFC7636 } from '../helpers/pkce'

const call = (path: string, token?: string, init: RequestInit = {}) =>
  SELF.fetch(`https://auth.internal/admin${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })

const callerWith = async (granted: string[]) => {
  const role = await createRole({ slug: `caller-${crypto.randomUUID().slice(0, 8)}`, permissions: granted })
  return signIn({ roleIds: [role.id] })
}

describe('GET /admin/applications', () => {
  it('lists the registered clients without their secret hash', async () => {
    const { token } = await callerWith(['applications:read'])
    await createApplication({ clientSecretHash: await sha256('hidden'), redirectUris: ['https://c.test/cb'] })

    const response = await call('/applications', token)
    const body = await response.json<{ data: Record<string, unknown>[] }>()

    expect(response.status).toBe(200)
    expect(body.data.map((row) => row.client_id)).toContain(SEED.webAppId)
    expect(Object.keys(body.data[0] ?? {}).sort()).toEqual([
      'client_id',
      'confidential',
      'created_at',
      'description',
      'is_active',
      'name',
      'redirect_uris',
      'updated_at',
    ])
    expect(JSON.stringify(body)).not.toContain(await sha256('hidden'))
  })

  it('reports the seeded clients as public with their exact redirect URIs', async () => {
    const { token } = await callerWith(['applications:read'])

    const body = await (await call('/applications', token)).json<{
      data: { client_id: string; confidential: boolean; redirect_uris: string[] }[]
    }>()
    const web = body.data.find((row) => row.client_id === SEED.webAppId)

    expect(web?.confidential).toBe(false)
    expect(web?.redirect_uris).toEqual([SEED.webRedirectUri, SEED.webLocalRedirectUri])
  })

  it('refuses a caller without applications:read', async () => {
    const { token } = await callerWith(['users:read'])

    const response = await call('/applications', token)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: 'Missing required permission: applications:read' })
  })
})

describe('POST /admin/applications', () => {
  it('registers a public client that can immediately start a flow', async () => {
    const { token } = await callerWith(['applications:write'])

    const response = await call('/applications', token, {
      method: 'POST',
      body: JSON.stringify({
        client_id: 'new-public-client',
        name: 'New client',
        redirect_uris: ['https://new.test/callback'],
      }),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      code: 201,
      data: {
        client_id: 'new-public-client',
        name: 'New client',
        confidential: false,
        client_secret: null,
        redirect_uris: ['https://new.test/callback'],
        is_active: true,
      },
    })

    const authorize = await SELF.fetch(
      `https://auth.internal/oauth/google/authorize?${new URLSearchParams({
        client_id: 'new-public-client',
        redirect_uri: 'https://new.test/callback',
        code_challenge: RFC7636.challenge,
      })}`,
      { redirect: 'manual' },
    )
    expect(authorize.status).toBe(302)
  })

  it('returns a confidential client\'s secret once, and stores only its hash', async () => {
    const { token } = await callerWith(['applications:write'])

    const body = await (
      await call('/applications', token, {
        method: 'POST',
        body: JSON.stringify({
          client_id: 'new-confidential',
          name: 'Confidential',
          redirect_uris: ['https://conf.test/cb'],
          confidential: true,
        }),
      })
    ).json<{ data: { client_secret: string; confidential: boolean } }>()

    expect(body.data.confidential).toBe(true)
    expect(body.data.client_secret).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const [row] = await db().select().from(applications).where(eq(applications.id, 'new-confidential'))
    expect(row?.clientSecretHash).toBe(await sha256(body.data.client_secret))

    // The secret is nowhere in the listing afterwards.
    const listed = await (await call('/applications', token)).text()
    expect(listed).not.toContain(body.data.client_secret)
  })

  it('refuses a client_id that is already taken', async () => {
    const { token } = await callerWith(['applications:write'])

    const response = await call('/applications', token, {
      method: 'POST',
      body: JSON.stringify({ client_id: SEED.webAppId, name: 'Impostor', redirect_uris: ['https://x.test/cb'] }),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ code: 409, error: 'That client_id is already registered' })
  })

  it('validates the client_id shape', async () => {
    const { token } = await callerWith(['applications:write'])
    const create = (clientId: string) =>
      call('/applications', token, {
        method: 'POST',
        body: JSON.stringify({ client_id: clientId, name: 'X', redirect_uris: ['https://x.test/cb'] }),
      })

    for (const clientId of ['Upper-Case', 'a', '-leading', 'has space', 'under_score', 'a'.repeat(64)]) {
      expect((await create(clientId)).status).toBe(400)
    }
  })

  it('requires at least one absolute, fragment-free redirect URI', async () => {
    const { token } = await callerWith(['applications:write'])
    const create = (redirectUris: unknown) =>
      call('/applications', token, {
        method: 'POST',
        body: JSON.stringify({ client_id: `c-${crypto.randomUUID().slice(0, 8)}`, name: 'X', redirect_uris: redirectUris }),
      })

    expect((await create([])).status).toBe(400)
    expect((await create(['/relative'])).status).toBe(400)
    // A fragment can never survive the redirect, so it would silently not match.
    expect((await create(['https://x.test/cb#token'])).status).toBe(400)
    expect((await create(['https://x.test/cb'])).status).toBe(201)
  })

  it('records application.created with whether a secret was issued', async () => {
    const caller = await callerWith(['applications:write'])

    await call('/applications', caller.token, {
      method: 'POST',
      body: JSON.stringify({
        client_id: 'audited-client',
        name: 'Audited',
        redirect_uris: ['https://audited.test/cb'],
        confidential: true,
      }),
    })

    const [row] = await db().select().from(auditLogs).where(eq(auditLogs.applicationId, 'audited-client'))
    expect(row?.event).toBe('application.created')
    expect(JSON.parse(row?.metadata ?? 'null')).toEqual({ confidential: true })
  })

  it('refuses a caller with only applications:read', async () => {
    const { token } = await callerWith(['applications:read'])

    const response = await call('/applications', token, {
      method: 'POST',
      body: JSON.stringify({ client_id: 'denied', name: 'X', redirect_uris: ['https://x.test/cb'] }),
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: 'Missing required permission: applications:write' })
  })
})

describe('PATCH /admin/applications/:id', () => {
  it('replaces the redirect URI list, and the new list is what is enforced', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await createApplication({ redirectUris: ['https://old.test/cb'] })

    const response = await call(`/applications/${application.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ redirect_uris: ['https://new.test/cb'] }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ data: { redirect_uris: ['https://new.test/cb'] } })

    const start = (redirectUri: string) =>
      SELF.fetch(
        `https://auth.internal/oauth/google/authorize?${new URLSearchParams({
          client_id: application.id,
          redirect_uri: redirectUri,
          code_challenge: RFC7636.challenge,
        })}`,
        { redirect: 'manual' },
      )

    expect((await start('https://new.test/cb')).status).toBe(302)
    expect((await start('https://old.test/cb')).status).toBe(400)
  })

  it('deactivating a client stops new sign-ins at once', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await createApplication({ redirectUris: ['https://live.test/cb'] })

    await call(`/applications/${application.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ is_active: false }),
    })

    const start = await SELF.fetch(
      `https://auth.internal/oauth/google/authorize?${new URLSearchParams({
        client_id: application.id,
        redirect_uri: 'https://live.test/cb',
        code_challenge: RFC7636.challenge,
      })}`,
      { redirect: 'manual' },
    )
    expect(start.status).toBe(400)
  })

  it('leaves omitted fields alone and clears a description sent as null', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await createApplication({ name: 'Original', redirectUris: ['https://keep.test/cb'] })
    await db().update(applications).set({ description: 'Something' }).where(eq(applications.id, application.id))

    await call(`/applications/${application.id}`, token, { method: 'PATCH', body: JSON.stringify({ description: null }) })

    const [row] = await db().select().from(applications).where(eq(applications.id, application.id))
    expect(row).toMatchObject({ name: 'Original', description: null, redirectUris: '["https://keep.test/cb"]' })
  })

  it('never turns a public client into a confidential one', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await createApplication()

    await call(`/applications/${application.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ confidential: true, client_secret: 'injected' }),
    })

    const [row] = await db().select().from(applications).where(eq(applications.id, application.id))
    expect(row?.clientSecretHash).toBeNull()
  })

  it('answers 404 for an unknown application', async () => {
    const { token } = await callerWith(['applications:write'])

    const response = await call('/applications/no-such-app', token, { method: 'PATCH', body: '{}' })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ code: 404, error: 'Application not found' })
  })

  it('rejects an invalid redirect URI list rather than storing it', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await createApplication({ redirectUris: ['https://keep.test/cb'] })

    expect(
      (await call(`/applications/${application.id}`, token, { method: 'PATCH', body: JSON.stringify({ redirect_uris: [] }) }))
        .status,
    ).toBe(400)
    expect(
      (await call(`/applications/${application.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ redirect_uris: ['not a url'] }),
      })).status,
    ).toBe(400)

    const [row] = await db().select().from(applications).where(eq(applications.id, application.id))
    expect(row?.redirectUris).toBe('["https://keep.test/cb"]')
  })

  it('refuses a caller with only applications:read', async () => {
    const { token } = await callerWith(['applications:read'])
    const application = await createApplication()

    expect((await call(`/applications/${application.id}`, token, { method: 'PATCH', body: '{}' })).status).toBe(403)
  })
})
