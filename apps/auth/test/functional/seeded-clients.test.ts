import { SELF } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { applications, permissions, rolePermissions, roles } from '@/db/schema'
import { db, SEED } from '../helpers/db'
import { RFC7636 } from '../helpers/pkce'

/**
 * The seeded clients as the front-end actually uses them.
 *
 * Every failure the site's sign-in screen can hit before a user types anything is decided by two
 * columns of `applications`: the grants the client may use, and the exact redirect URIs it may be
 * sent back to. Both were wrong against the deployed database — `grant_types` was empty, and the
 * CMS was registered on a subdomain it does not live on — which is what `0005_repair_client_config.sql`
 * fixes. These cases hold that configuration to the routes the front-end really serves, so moving a
 * callback route without registering it fails here instead of in production.
 */

const authorize = (params: Record<string, string>) =>
  SELF.fetch(
    `https://auth.internal/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      code_challenge: RFC7636.challenge,
      code_challenge_method: 'S256',
      scope: 'openid profile email',
      ...params,
    })}`,
    { redirect: 'manual' },
  )

/**
 * The authorization endpoint hands the browser to the sign-in front-end only once the request is
 * fully accepted; a rejected one is a redirect back to the client carrying `error`, and an
 * unregistered redirect URI is a 400. So an accepted request is the redirect that carries a parked
 * handle.
 */
const isAccepted = (response: Response) => {
  if (response.status !== 302) return false
  const target = new URL(response.headers.get('Location') as string)
  return target.searchParams.has('request') && !target.searchParams.has('error')
}

describe('the client applications the front-end signs in with', () => {
  it.each([
    ['the site, in production', SEED.webAppId, SEED.webRedirectUri],
    ['the site, on the Vite dev server', SEED.webAppId, SEED.webLocalRedirectUri],
    ['the CMS, in production', SEED.cmsAppId, SEED.cmsSiteRedirectUri],
    ['the CMS, on the Vite dev server', SEED.cmsAppId, SEED.cmsSiteLocalRedirectUri],
    ['the CMS, on its own subdomain', SEED.cmsAppId, SEED.cmsRedirectUri],
    ['the support console, in production', SEED.supportAppId, SEED.supportRedirectUri],
    ['the support console, on the Vite dev server', SEED.supportAppId, SEED.supportLocalRedirectUri],
  ])('accepts an authorization request for %s', async (_label, clientId, redirectUri) => {
    const response = await authorize({ client_id: clientId, redirect_uri: redirectUri })

    expect(isAccepted(response), response.headers.get('Location') ?? `${response.status}`).toBe(true)
  })

  it.each([
    ['the site', SEED.webAppId, SEED.webRedirectUri],
    ['the CMS', SEED.cmsAppId, SEED.cmsSiteRedirectUri],
    ['the support console', SEED.supportAppId, SEED.supportRedirectUri],
  ])('lets %s use the authorization code grant', async (_label, clientId, redirectUri) => {
    const response = await authorize({ client_id: clientId, redirect_uri: redirectUri, state: 'st' })

    // A client without the grant is answered with a redirect carrying `error=unauthorized_client`,
    // which is exactly what the deployed database was doing for both of them.
    expect(response.headers.get('Location') ?? '').not.toContain('error=unauthorized_client')
    expect(isAccepted(response)).toBe(true)
  })

  it.each([
    ['the site', SEED.webAppId],
    ['the CMS', SEED.cmsAppId],
    ['the support console', SEED.supportAppId],
  ])('registers the Cloudflare preview origin on %s', async (_label, clientId) => {
    const [row] = await db().select().from(applications).where(eq(applications.id, clientId))

    // Cross-origin access is decided from these rows, so without the pattern a preview deployment
    // of the front-end cannot make a single call to this Worker — see `0006_preview_origins.sql`.
    expect(JSON.parse(row?.allowedOrigins ?? '[]')).toContain(SEED.previewOriginPattern)
  })

  it('does not let the preview origin become a redirect URI', async () => {
    const response = await authorize({
      client_id: SEED.webAppId,
      redirect_uri: 'https://preview-franciscosolis.franciscosolis.workers.dev/auth/callback',
    })

    // The wildcard opens CORS and stops there: where an authorization code may be sent is still an
    // exact list, so a preview has to register its own callback before it can complete a sign-in.
    expect(response.status).toBe(400)
  })

  it('gives the support console the permissions apps/support checks for', async () => {
    const rows = await db()
      .select({ slug: permissions.slug })
      .from(rolePermissions)
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(eq(rolePermissions.roleId, SEED.supportAgentRoleId))

    // `apps/support` is the first Worker here that enforces a permission rather than stopping at the
    // email-domain gate, so this row is what makes an account an agent at all.
    expect(rows.map((row) => row.slug)).toEqual(['support:agent'])
  })

  it('keeps the administrator role holding the support permissions too', async () => {
    const rows = await db()
      .select({ slug: permissions.slug })
      .from(rolePermissions)
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(eq(rolePermissions.roleId, SEED.adminRoleId))

    // `0001_seed.sql` filled the admin role by selecting from `permissions` at the time it ran, so a
    // permission added later has to be attached explicitly — otherwise an existing administrator is
    // locked out of a console they own.
    expect(rows.map((row) => row.slug)).toEqual(expect.arrayContaining(['support:agent', 'support:admin']))
  })

  it('scopes the support roles to the support application', async () => {
    const [row] = await db().select().from(roles).where(eq(roles.id, SEED.supportAgentRoleId))

    // Not a global role: `getUserAuthorization` resolves roles per application, and that is the
    // whole reason support has a client id of its own rather than reusing the CMS's audience.
    expect(row?.applicationId).toBe(SEED.supportAppId)
  })

  it('still matches a redirect URI exactly, with no room for a near miss', async () => {
    const response = await authorize({
      client_id: SEED.webAppId,
      redirect_uri: 'https://franciscosolis.cl/auth/callback/',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('not registered'),
    })
  })
})
