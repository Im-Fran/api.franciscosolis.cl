import { and, eq } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { getDb } from '@/db/client'
import { installations } from '@/db/schema'
import type { AppEnv } from '@/env'
import { hashToken } from '@/lib/tokens'
import { bearerToken } from '@/middleware/admin'

/** A 401 that tells a device which recovery applies, per RFC 6750. */
const invalidToken = (description: string) =>
  new HTTPException(401, {
    message: description,
    res: new Response(JSON.stringify({ code: 401, error: description }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'WWW-Authenticate': `Bearer error="invalid_token", error_description="${description}"`,
      },
    }),
  })

/**
 * Gate for every ingest route but enrollment, refresh and the public documents: the bearer token of
 * an active installation **of the app in the URL**, unexpired.
 *
 * A lookup by hash rather than a signature check, which is what makes revocation take effect on the
 * very next request. Every failure is the same 401 on purpose — "no such token", "revoked" and
 * "belongs to another app" must be indistinguishable to whoever is guessing — and the device's
 * recovery is the same for all of them: refresh, and if that fails, enroll again.
 *
 * Then a per-installation rate limit, so one misbehaving device cannot spend the fleet's budget.
 */
const requireInstallation = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c.req.header('Authorization'))
  if (!token) {
    throw invalidToken('A Bearer installation token is required')
  }

  const appId = c.req.param('appId') ?? ''
  const [row] = await getDb(c.env)
    .select({
      id: installations.id,
      appId: installations.appId,
      status: installations.status,
      expiresAt: installations.accessTokenExpiresAt,
    })
    .from(installations)
    .where(and(eq(installations.accessTokenHash, await hashToken(token)), eq(installations.appId, appId)))
    .limit(1)

  if (!row || row.status !== 'active' || !row.expiresAt || row.expiresAt.getTime() <= Date.now()) {
    throw invalidToken('The installation token is invalid, expired or revoked')
  }

  const { success } = await c.env.INGEST_LIMITER.limit({ key: row.id })
  if (!success) {
    throw new HTTPException(429, {
      message: 'Too many requests from this installation',
      res: new Response(JSON.stringify({ code: 429, error: 'Too many requests from this installation' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Retry-After': '60' },
      }),
    })
  }

  c.set('device', { installationId: row.id, appId: row.appId })
  await next()
})

export { invalidToken, requireInstallation }
