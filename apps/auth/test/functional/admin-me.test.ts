import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createRole, SEED, signIn } from '../helpers/db'

const call = (token?: string) =>
  SELF.fetch('https://auth.internal/admin/me', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })

describe('GET /admin/me', () => {
  it('reports the caller, their roles and their permissions', async () => {
    const role = await createRole({ slug: `me-${crypto.randomUUID().slice(0, 8)}`, permissions: ['users:read', 'audit:read'] })
    const { token, user, applicationId } = await signIn({ roleIds: [role.id] })

    const response = await call(token)
    const body = await response.json<{
      data: { user: { id: string; email: string }; application_id: string; roles: string[]; permissions: string[] }
    }>()

    expect(response.status).toBe(200)
    expect(body.data.user).toMatchObject({ id: user.id, email: user.email })
    expect(body.data.application_id).toBe(applicationId)
    expect(body.data.roles).toContain(role.slug)
    expect(body.data.permissions).toEqual(['audit:read', 'users:read'])
  })

  it('refuses an account that holds no administration permission', async () => {
    const { token } = await signIn({ roleIds: [SEED.userRoleId] })

    const response = await call(token)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: 'This account has no access to the administration API',
    })
  })

  it('answers from the database, not from the token body', async () => {
    const { token } = await signIn({ claimedPermissions: ['users:write', 'roles:write'] })

    // The token says the caller administers everything; the database says they hold nothing, and
    // the database is what `requireAuth` re-reads on every request.
    expect((await call(token)).status).toBe(403)
  })

  it('requires a token at all', async () => {
    expect((await call()).status).toBe(401)
  })
})
