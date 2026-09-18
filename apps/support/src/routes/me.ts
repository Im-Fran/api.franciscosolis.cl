import type { Context } from 'hono'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver } from 'hono-openapi'
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { ticketParticipants, tickets } from '@/db/schema'
import type { AppEnv } from '@/env'
import { PAGINATION } from '@/lib/config'
import type { AccessTokenClaims } from '@/lib/jwks'
import { verifyAccessToken } from '@/lib/jwks'
import { bearerToken, describeTokenError } from '@/middleware/auth'
import { recordAudit } from '@/services/audit'
import { toTicketSummary } from '@/services/tickets'

/**
 * The signed-in half of the requester experience.
 *
 * This is the other side of the hybrid identity model. A ticket can be opened by anybody with an
 * email address and read back with the secret in the emailed link — but if the person happens to
 * have an account here, they should not have to keep that email to find their own tickets.
 *
 * The thing that makes this awkward, and worth reading before changing: **this Worker cannot ask
 * whether an address has an account.** It has no binding into the auth database and must never get
 * one — tokens are verified offline against the published JWKS precisely so that no service has to
 * call back into auth. So the link between a ticket and an account is only ever made at a moment
 * when a verified token is in hand: either the ticket was opened with one, or the account holder
 * comes here and claims it.
 */
const app = new Hono<AppEnv>()

/** Any verified requester token. Deliberately not `requireAgent`: these routes are for the public. */
const requireRequester = async (c: Context<AppEnv>) => {
  const token = bearerToken(c.req.header('Authorization'))
  if (!token) {
    throw new HTTPException(401, { message: 'A Bearer access token is required' })
  }
  let claims: AccessTokenClaims
  try {
    claims = await verifyAccessToken(c.env, token, c.env.SUPPORT_REQUESTER_AUDIENCES)
  } catch (error) {
    throw new HTTPException(401, { message: `Invalid access token: ${describeTokenError(error)}` })
  }
  if (!claims.email_verified) {
    // The whole of this file is an assertion about an address, so an unverified one proves nothing.
    throw new HTTPException(403, { message: 'This account has no verified email address' })
  }
  return { claims, email: claims.email.toLowerCase() }
}

const listResponseSchema = v.object({
  code: v.literal(200),
  data: v.array(v.looseObject({ reference: v.string() })),
})

app.get(
  '/me/tickets',
  describeRoute({
    description:
      'Tickets belonging to the signed-in account: the ones it opened, plus any it was put on copy of. Matched on the account id and on the verified email, so a ticket opened before signing in is included.',
    tags: ['Tickets'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Your tickets', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      403: { description: 'The account has no verified email address' },
    },
  }),
  async (c) => {
    const { claims, email } = await requireRequester(c)
    const db = getDb(c.env)

    const rows = await db
      .select()
      .from(tickets)
      .where(
        and(
          sql`${tickets.status} <> 'spam'`,
          or(
            eq(tickets.requesterUserId, claims.sub),
            eq(tickets.requesterEmail, email),
            sql`exists (select 1 from ${ticketParticipants} where ${ticketParticipants.ticketId} = ${tickets.id} and ${ticketParticipants.email} = ${email})`,
          ),
        ),
      )
      .orderBy(desc(tickets.updatedAt))
      .limit(PAGINATION.defaultLimit)

    return c.json({ code: 200, data: rows.map(toTicketSummary) })
  },
)

app.post(
  '/me/tickets/claim',
  describeRoute({
    description:
      'Links tickets opened anonymously with this account\'s verified email to the account, so they appear under it from now on. Idempotent, and safe to call on every visit.',
    tags: ['Tickets'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'How many tickets were linked' },
      401: { description: 'Missing or invalid access token' },
      403: { description: 'The account has no verified email address' },
    },
  }),
  async (c) => {
    const { claims, email } = await requireRequester(c)
    const db = getDb(c.env)

    const claimed = await db
      .update(tickets)
      .set({ requesterUserId: claims.sub, updatedAt: new Date() })
      .where(and(eq(tickets.requesterEmail, email), isNull(tickets.requesterUserId)))
      .returning({ id: tickets.id })

    // Participants are claimed too, so a watcher's console shows the ticket under their account
    // rather than only when they still have the link.
    await db
      .update(ticketParticipants)
      .set({ userId: claims.sub })
      .where(and(eq(ticketParticipants.email, email), isNull(ticketParticipants.userId)))

    if (claimed.length > 0) {
      await recordAudit(db, {
        event: 'ticket.claimed',
        actorEmail: email,
        actorId: claims.sub,
        resourceType: 'tickets',
        metadata: { claimed: claimed.length },
      })
    }

    return c.json({ code: 200, data: { claimed: claimed.length } })
  },
)

export default app
