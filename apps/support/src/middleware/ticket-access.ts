import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { ticketParticipants, tickets } from '@/db/schema'
import type { AppEnv } from '@/env'
import { AGENT_PERMISSION } from '@/lib/config'
import type { AccessTokenClaims } from '@/lib/jwks'
import { verifyAccessToken } from '@/lib/jwks'
import { parseReference } from '@/lib/references'
import { sha256 } from '@/lib/tokens'
import { bearerToken, isAllowedEmail, toAgent } from '@/middleware/auth'
import type { TicketRow } from '@/services/tickets'

/**
 * Who is asking, and therefore how much of the thread they may see.
 *
 * `agent` sees internal notes and every address on the ticket; `requester` sees the conversation.
 * There is no third level: somebody who cannot be resolved into one of these two never learns the
 * ticket exists.
 */
type AccessLevel = 'agent' | 'requester'

type TicketAccess = {
  ticket: TicketRow
  level: AccessLevel
  /** The address the caller acted as, for authorship on anything they post. Null for a link holder. */
  actorEmail: string | null
  actorName: string | null
  actorUserId: string | null
}

declare module 'hono' {
  interface ContextVariableMap {
    ticketAccess: TicketAccess
  }
}

/**
 * Reads the per-ticket access secret off the request.
 *
 * Three places, in descending order of how much we like them:
 *
 * 1. `Authorization: Ticket <secret>` — what the front-end sends. A custom scheme rather than
 *    `Bearer` so the agent path above can tell the two apart instead of trying to verify a random
 *    string as a JWT and returning a confusing 401.
 * 2. `X-Support-Ticket-Token` — for a client that cannot set `Authorization`.
 * 3. `?token=` — documented as a convenience for curl and for tests. Nothing this Worker *generates*
 *    ever puts the secret in a query string: the emailed link carries it in the fragment, which is
 *    never sent to a server at all. Accepting it here is a narrow exception, not the design.
 */
const ticketToken = (header: string | undefined, custom: string | undefined, query: string | undefined) => {
  if (header) {
    const [scheme, ...rest] = header.split(' ')
    if (scheme?.toLowerCase() === 'ticket' && rest.length > 0) {
      return rest.join(' ').trim() || null
    }
  }
  return custom?.trim() || query?.trim() || null
}

/**
 * Resolves `:reference` into a ticket the caller is entitled to, or a 404.
 *
 * **It is always a 404, never a 403.** A 403 would confirm that `FS-1042` exists, and ticket numbers
 * are short and sequential — so a 403 turns the reference space into an oracle that enumerates every
 * support request ever filed, complete with the fact that a given person filed one. "No such ticket"
 * and "not yours" have to be indistinguishable from outside.
 *
 * Three ways in, first match wins:
 *
 * 1. **Agent** — a Bearer token from an accepted console audience, verified email on an allowed
 *    domain, holding `support:agent`.
 * 2. **Requester with a session** — a Bearer token from the wider requester audience list whose
 *    verified email is the requester's or a participant's. Using it also *claims* the ticket, so a
 *    ticket opened anonymously starts showing up under the account from then on.
 * 3. **The link secret** — matched by hash against this ticket's row, so a valid secret for another
 *    ticket resolves to nothing here.
 */
const requireTicketAccess = createMiddleware<AppEnv>(async (c, next) => {
  const number = parseReference(c.req.param('reference') ?? '')
  const db = getDb(c.env)

  // Resolved before anything else so every failure below leaves through the same door.
  const ticket = number === null ? null : ((await db.select().from(tickets).where(eq(tickets.number, number)).limit(1))[0] ?? null)

  const notFound = () => new HTTPException(404, { message: 'Ticket not found' })

  const bearer = bearerToken(c.req.header('Authorization'))
  if (bearer) {
    // Tried as an agent first, then as a requester. The two audience lists are deliberately separate
    // (see `src/env.ts`), so a token good for the website is not silently good for the console.
    const agentClaims = await tryVerify(c.env, bearer, c.env.SUPPORT_ALLOWED_AUDIENCES)
    if (
      agentClaims &&
      agentClaims.email_verified &&
      isAllowedEmail(c.env, agentClaims.email) &&
      (agentClaims.permissions ?? []).includes(AGENT_PERMISSION)
    ) {
      if (!ticket) {
        throw notFound()
      }
      const agent = toAgent(agentClaims)
      c.set('ticketAccess', {
        ticket,
        level: 'agent',
        actorEmail: agent.email,
        actorName: agent.name,
        actorUserId: agent.id,
      })
      await next()
      return
    }

    const requesterClaims = await tryVerify(c.env, bearer, c.env.SUPPORT_REQUESTER_AUDIENCES)
    if (requesterClaims?.email_verified && ticket) {
      const email = requesterClaims.email.toLowerCase()
      const isRequester = ticket.requesterEmail === email
      const participant = isRequester
        ? null
        : (
            await db
              .select()
              .from(ticketParticipants)
              .where(eq(ticketParticipants.ticketId, ticket.id))
              .limit(200)
          ).find((row) => row.email === email)

      if (isRequester || participant) {
        // Claiming on read. This Worker cannot ask the auth database whether an address has an
        // account — it has no binding into it and must never get one — so a verified token arriving
        // on a request is the only moment the link can be made at all.
        if (isRequester && ticket.requesterUserId === null) {
          await db.update(tickets).set({ requesterUserId: requesterClaims.sub }).where(eq(tickets.id, ticket.id))
          ticket.requesterUserId = requesterClaims.sub
        }
        c.set('ticketAccess', {
          ticket,
          level: 'requester',
          actorEmail: email,
          actorName: requesterClaims.name ?? null,
          actorUserId: requesterClaims.sub,
        })
        await next()
        return
      }
    }

    throw notFound()
  }

  const secret = ticketToken(
    c.req.header('Authorization'),
    c.req.header('X-Support-Ticket-Token'),
    c.req.query('token'),
  )
  if (!secret || !ticket) {
    throw notFound()
  }

  // Compared against *this* ticket's stored hash, so a perfectly valid secret for another ticket
  // does not open this one.
  if (ticket.accessTokenHash !== (await sha256(secret))) {
    throw notFound()
  }

  c.set('ticketAccess', {
    ticket,
    level: 'requester',
    actorEmail: ticket.requesterEmail,
    actorName: ticket.requesterName,
    actorUserId: ticket.requesterUserId,
  })
  await next()
})

/** Verification that answers "no" instead of throwing, because this middleware tries twice. */
const tryVerify = async (
  env: AppEnv['Bindings'],
  token: string,
  audiences: string,
): Promise<AccessTokenClaims | null> => {
  try {
    return await verifyAccessToken(env, token, audiences)
  } catch {
    return null
  }
}

export { requireTicketAccess, ticketToken }
export type { AccessLevel, TicketAccess }
