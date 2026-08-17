import { SELF, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

/**
 * Covers the two things the rest of this app's suite depends on: the real `migrations/` directory
 * applies cleanly to a fresh database, and the Worker signs with the injected test key. If either
 * breaks, every other failure in this app is a symptom rather than a cause.
 */
describe('auth smoke', () => {
  it('applies the schema and the permission seed', async () => {
    const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM permissions').first<{ total: number }>()

    // 0001_seed.sql inserts the eleven baseline permissions.
    expect(row?.total).toBe(11)
  })

  it('seeds the two client applications as public clients', async () => {
    const { results } = await env.DB.prepare(
      'SELECT id, token_endpoint_auth_method, require_pkce, is_active FROM applications ORDER BY id',
    ).all<{ id: string; token_endpoint_auth_method: string; require_pkce: number; is_active: number }>()

    expect(results.map((row) => row.id)).toEqual(['franciscosolis-cms', 'franciscosolis-web'])
    // Authenticating with nothing means PKCE is mandatory for both — that is the security
    // property, not an incidental default.
    expect(results.every((row) => row.token_endpoint_auth_method === 'none')).toBe(true)
    expect(results.every((row) => row.require_pkce === 1)).toBe(true)
    expect(results.every((row) => row.is_active === 1)).toBe(true)
  })

  it('leaves no client holding a secret out of the box', async () => {
    const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM application_secrets').first<{ total: number }>()

    expect(row?.total).toBe(0)
  })

  it('grants the admin role every defined permission', async () => {
    const row = await env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM role_permissions WHERE role_id = '8e7a797c-5012-4a96-a9a2-e8b5bdaeb802') AS granted,
        (SELECT COUNT(*) FROM permissions) AS total
    `).first<{ granted: number; total: number }>()

    expect(row?.granted).toBe(row?.total)
  })

  it('publishes the signing key, and only its public half', async () => {
    const response = await SELF.fetch('https://auth.internal/.well-known/jwks.json')
    expect(response.status).toBe(200)

    const body = await response.json<{ keys: Record<string, unknown>[] }>()
    const [key] = body.keys

    expect(key).toMatchObject({
      kid: 'zkYWu6vANSKYDOXRS4kw3_owd0qlSMSkVvyPMlwF0uQ',
      kty: 'OKP',
      crv: 'Ed25519',
      alg: 'EdDSA',
    })
    // Publishing `d` would hand out the private scalar to every consumer of the JWKS.
    expect(key).not.toHaveProperty('d')
  })
})
