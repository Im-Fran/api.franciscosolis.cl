import { SELF } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { auditLogs } from '@/db/schema'
import { sha256 } from '@/lib/crypto'
import { createApplication, createRole, createSecret, db, findSecrets, signIn } from '../helpers/db'

const call = (path: string, token: string, init: RequestInit = {}) =>
  SELF.fetch(`https://auth.internal/admin${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })

const callerWith = async (permissions: string[]) => {
  const role = await createRole({ permissions })
  return signIn({ roleIds: [role.id] })
}

const confidential = (overrides: Parameters<typeof createApplication>[0] = {}) =>
  createApplication({ tokenEndpointAuthMethod: 'client_secret_post', ...overrides })

describe('GET /admin/applications/:id/secrets', () => {
  it('lists the secrets without anything that could be presented as one', async () => {
    const { token } = await callerWith(['applications:read'])
    const application = await confidential()
    await createSecret(application.id, 'a-real-secret', { label: 'deploy' })

    const response = await call(`/applications/${application.id}/secrets`, token)
    const raw = await response.text()
    const body = JSON.parse(raw) as { data: Record<string, unknown>[] }

    expect(response.status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(Object.keys(body.data[0]).sort()).toEqual([
      'active',
      'created_at',
      'expires_at',
      'hint',
      'id',
      'label',
      'last_used_at',
      'revoked_at',
    ])
    expect(raw).not.toContain('a-real-secret')
    expect(raw).not.toContain(await sha256('a-real-secret'))
  })

  it('keeps a hint short enough to identify a secret without revealing it', async () => {
    const { token } = await callerWith(['applications:read'])
    const application = await confidential()
    await createSecret(application.id, 'abcdefghijklmnop')

    const body = await (await call(`/applications/${application.id}/secrets`, token)).json<{
      data: { hint: string }[]
    }>()

    expect(body.data[0].hint).toBe('abcdef')
  })

  it('reports an expired or revoked secret as inactive', async () => {
    const { token } = await callerWith(['applications:read'])
    const application = await confidential()
    await createSecret(application.id, 'expired-one', { expiresAt: new Date(Date.now() - 1000) })
    await createSecret(application.id, 'revoked-one', { revokedAt: new Date() })
    await createSecret(application.id, 'live-one')

    const body = await (await call(`/applications/${application.id}/secrets`, token)).json<{
      data: { hint: string; active: boolean }[]
    }>()

    expect(body.data.filter((secret) => secret.active).map((secret) => secret.hint)).toEqual(['live-o'])
  })

  it('needs applications:read and answers 404 for an unknown client', async () => {
    const reader = await callerWith(['applications:read'])
    const nobody = await signIn()

    expect((await call('/applications/no-such-app/secrets', reader.token)).status).toBe(404)
    expect((await call('/applications/no-such-app/secrets', nobody.token)).status).toBe(403)
  })
})

describe('POST /admin/applications/:id/secrets', () => {
  it('returns the plaintext once and stores only its hash', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await confidential()

    const response = await call(`/applications/${application.id}/secrets`, token, {
      method: 'POST',
      body: JSON.stringify({ label: 'ci' }),
    })
    const body = await response.json<{ data: { client_secret: string; hint: string; label: string } }>()

    expect(response.status).toBe(201)
    expect(body.data.client_secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(body.data.label).toBe('ci')

    const [stored] = await findSecrets(application.id)
    expect(stored.secretHash).toBe(await sha256(body.data.client_secret))

    const listed = await (await call(`/applications/${application.id}/secrets`, token)).text()
    expect(listed).not.toContain(body.data.client_secret)
  })

  it('adds a secret without touching the existing ones, unless asked to rotate', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await confidential()
    await createSecret(application.id, 'the-incumbent')

    await call(`/applications/${application.id}/secrets`, token, { method: 'POST', body: '{}' })

    const stored = await findSecrets(application.id)
    expect(stored).toHaveLength(2)
    expect(stored.every((secret) => !secret.revokedAt && !secret.expiresAt)).toBe(true)
  })

  it('rotating gives the outgoing secrets a deadline instead of cutting them off', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await confidential()
    await createSecret(application.id, 'to-be-rotated')

    const body = await (
      await call(`/applications/${application.id}/secrets`, token, {
        method: 'POST',
        body: JSON.stringify({ rotate: true, grace_seconds: 3600 }),
      })
    ).json<{ data: { id: string; retired_secrets: number } }>()

    expect(body.data.retired_secrets).toBe(1)
    const outgoing = (await findSecrets(application.id)).find((secret) => secret.id !== body.data.id)
    expect(outgoing?.revokedAt).toBeNull()
    expect(outgoing?.expiresAt?.getTime()).toBeGreaterThan(Date.now())
  })

  it('rotating with no grace revokes them at once, which is what a leak calls for', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await confidential()
    await createSecret(application.id, 'leaked-secret')

    const body = await (
      await call(`/applications/${application.id}/secrets`, token, {
        method: 'POST',
        body: JSON.stringify({ rotate: true, grace_seconds: 0 }),
      })
    ).json<{ data: { id: string } }>()

    const outgoing = (await findSecrets(application.id)).find((secret) => secret.id !== body.data.id)
    expect(outgoing?.revokedAt).not.toBeNull()
  })

  it('honours an expiry on the new secret itself', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await confidential()

    const body = await (
      await call(`/applications/${application.id}/secrets`, token, {
        method: 'POST',
        body: JSON.stringify({ expires_in: 3600 }),
      })
    ).json<{ data: { expires_at: string | null } }>()

    expect(new Date(body.data.expires_at as string).getTime()).toBeGreaterThan(Date.now())
  })

  it('refuses to give a public client a secret it could never present', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await createApplication()

    const response = await call(`/applications/${application.id}/secrets`, token, { method: 'POST', body: '{}' })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 400 })
    await expect(findSecrets(application.id)).resolves.toEqual([])
  })

  it('records the rotation, without the secret in the metadata', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await confidential()
    await createSecret(application.id, 'audited-rotation')

    const body = await (
      await call(`/applications/${application.id}/secrets`, token, {
        method: 'POST',
        body: JSON.stringify({ rotate: true }),
      })
    ).json<{ data: { client_secret: string } }>()

    const [row] = await db().select().from(auditLogs).where(eq(auditLogs.applicationId, application.id))
    expect(row?.event).toBe('application.secret_rotated')
    expect(row?.metadata).not.toContain(body.data.client_secret)
  })

  it('records a plain issue differently from a rotation', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await confidential()

    await call(`/applications/${application.id}/secrets`, token, { method: 'POST', body: '{}' })

    const [row] = await db().select().from(auditLogs).where(eq(auditLogs.applicationId, application.id))
    expect(row?.event).toBe('application.secret_issued')
  })

  it('needs applications:write, not merely applications:read', async () => {
    const { token } = await callerWith(['applications:read'])
    const application = await confidential()

    expect(
      (await call(`/applications/${application.id}/secrets`, token, { method: 'POST', body: '{}' })).status,
    ).toBe(403)
  })
})

describe('DELETE /admin/applications/:id/secrets/:secretId', () => {
  it('revokes one secret while the others keep working', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await confidential()
    const doomed = await createSecret(application.id, 'to-be-revoked')
    await createSecret(application.id, 'the-survivor')

    const response = await call(`/applications/${application.id}/secrets/${doomed.id}`, token, { method: 'DELETE' })

    expect(response.status).toBe(204)
    const stored = await findSecrets(application.id)
    expect(stored.find((secret) => secret.id === doomed.id)?.revokedAt).not.toBeNull()
    expect(stored.find((secret) => secret.hint === 'the-su')?.revokedAt).toBeNull()
  })

  it('refuses to revoke the last active secret of a confidential client', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await confidential()
    const only = await createSecret(application.id, 'the-only-one')

    const response = await call(`/applications/${application.id}/secrets/${only.id}`, token, { method: 'DELETE' })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'This is the last active secret of a confidential client; issue a replacement before revoking it',
    })
    expect((await findSecrets(application.id))[0].revokedAt).toBeNull()
  })

  it('is idempotent for a secret that was already revoked', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await confidential()
    const gone = await createSecret(application.id, 'already-gone', { revokedAt: new Date() })
    await createSecret(application.id, 'the-live-one')

    expect(
      (await call(`/applications/${application.id}/secrets/${gone.id}`, token, { method: 'DELETE' })).status,
    ).toBe(204)
  })

  it('answers 404 for a secret belonging to another client', async () => {
    const { token } = await callerWith(['applications:write'])
    const mine = await confidential()
    const theirs = await confidential()
    const secret = await createSecret(theirs.id, 'not-yours')

    expect((await call(`/applications/${mine.id}/secrets/${secret.id}`, token, { method: 'DELETE' })).status).toBe(404)
  })
})

describe('PATCH /admin/applications/:id and secrets', () => {
  it('revokes every secret when a confidential client is made public', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await confidential()
    await createSecret(application.id, 'no-longer-presentable')

    const response = await call(`/applications/${application.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ token_endpoint_auth_method: 'none' }),
    })

    expect(response.status).toBe(200)
    expect((await findSecrets(application.id)).every((secret) => secret.revokedAt !== null)).toBe(true)
  })

  it('refuses to leave a public client without PKCE', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await createApplication()

    const response = await call(`/applications/${application.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ require_pkce: false }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('require_pkce can only be turned off for a confidential client'),
    })
  })

  it('re-arms PKCE when a client that had it off is made public', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await confidential({ requirePkce: false })

    const body = await (
      await call(`/applications/${application.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ token_endpoint_auth_method: 'none' }),
      })
    ).json<{ data: { require_pkce: boolean } }>()

    // The invariant heals in the safe direction rather than dead-ending the caller.
    expect(body.data.require_pkce).toBe(true)
  })

  it('still refuses both at once, which is a contradiction rather than an oversight', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await confidential({ requirePkce: false })

    const response = await call(`/applications/${application.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ token_endpoint_auth_method: 'none', require_pkce: false }),
    })

    expect(response.status).toBe(400)
  })

  it('allows a confidential client to opt out of PKCE', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await confidential()

    const response = await call(`/applications/${application.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ require_pkce: false }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ data: { require_pkce: false } })
  })

  it('rejects an allowed origin that is not a bare origin', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await createApplication()

    const response = await call(`/applications/${application.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ allowed_origins: ['https://app.test/path'] }),
    })

    expect(response.status).toBe(400)
  })

  it('stores the grant types and scopes a client is limited to', async () => {
    const { token } = await callerWith(['applications:write'])
    const application = await confidential()

    const body = await (
      await call(`/applications/${application.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ grant_types: ['client_credentials'], scopes: ['openid', 'email'] }),
      })
    ).json<{ data: { grant_types: string[]; scopes: string[] } }>()

    expect(body.data.grant_types).toEqual(['client_credentials'])
    expect(body.data.scopes).toEqual(['openid', 'email'])
  })
})
