import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { SEED } from '../helpers/db'
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
  ])('accepts an authorization request for %s', async (_label, clientId, redirectUri) => {
    const response = await authorize({ client_id: clientId, redirect_uri: redirectUri })

    expect(isAccepted(response), response.headers.get('Location') ?? `${response.status}`).toBe(true)
  })

  it.each([
    ['the site', SEED.webAppId, SEED.webRedirectUri],
    ['the CMS', SEED.cmsAppId, SEED.cmsSiteRedirectUri],
  ])('lets %s use the authorization code grant', async (_label, clientId, redirectUri) => {
    const response = await authorize({ client_id: clientId, redirect_uri: redirectUri, state: 'st' })

    // A client without the grant is answered with a redirect carrying `error=unauthorized_client`,
    // which is exactly what the deployed database was doing for both of them.
    expect(response.headers.get('Location') ?? '').not.toContain('error=unauthorized_client')
    expect(isAccepted(response)).toBe(true)
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
