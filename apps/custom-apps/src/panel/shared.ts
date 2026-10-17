import { HTTPException } from 'hono/http-exception'
import * as v from 'valibot'
import { HEARTBEAT, PAGINATION } from '@/lib/config'
import { isUuid } from '@/lib/validation'
import { resolver } from 'hono-openapi'

/** Shared bits of the panel routes. */

/** 404 for an id that is not a UUID, without a database round trip. */
const assertId = (value: string | undefined, what: string): string => {
  if (value === undefined || !isUuid(value)) {
    throw new HTTPException(404, { message: `${what} not found` })
  }
  return value
}

const notFound = (what: string) => new HTTPException(404, { message: `${what} not found` })

const page = (query: { limit?: number; offset?: number }) => ({
  limit: query.limit ?? PAGINATION.defaultLimit,
  offset: query.offset ?? 0,
})

/** `%term%` for a LIKE, with the wildcards in the term itself escaped. */
const likeTerm = (term: string) => `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`

/*
 * A note for every correlated subquery in the panel routes: the outer column is written as a quoted,
 * qualified name (`"apps"."id"`), never as `${apps.id}`. Drizzle renders a column of a single-table
 * select unqualified, so `${companies.id}` inside `(SELECT COUNT(*) FROM apps WHERE …)` became a bare
 * `"id"` — which SQLite resolves to the *inner* table, and the count was silently wrong.
 */

/**
 * SQL deciding whether an installation row (aliased `i`, joined to its app as `a`, unless another
 * alias and interval expression are named) is connected at `now` (unix seconds). The same rule as `isConnected`, in SQL so
 * lists and counts can filter on it.
 * `now` and any interval passed are integers the Worker computed, never input, so they are inlined
 * rather than bound.
 */
const connectedSql = (now: number, installation = 'i', interval = 'a.heartbeat_interval_seconds') =>
  `(${installation}.status = 'active' AND ${installation}.last_seen_at IS NOT NULL AND ${installation}.last_seen_at >= ${Math.floor(now)} - ${interval} * ${HEARTBEAT.offlineAfterIntervals} AND NOT (${installation}.socket_closed_at IS NOT NULL AND ${installation}.socket_closed_at >= ${installation}.last_seen_at))`

const nowSeconds = () => Math.floor(Date.now() / 1000)

/** OpenAPI response content for a JSON schema. */
const jsonContent = (schema: v.GenericSchema) => ({ 'application/json': { schema: resolver(schema) } })

const dataSchema = (data: v.GenericSchema, code = 200) => v.object({ code: v.literal(code), data })
const listSchema = (item: v.GenericSchema) =>
  v.object({
    code: v.literal(200),
    data: v.array(item),
    pagination: v.object({ limit: v.number(), offset: v.number(), total: v.number() }),
  })

/** The standard error responses every panel route can answer. */
const panelErrors = {
  401: { description: 'Missing or invalid access token' },
  403: { description: 'Account not allowed into the panel' },
}

export { assertId, connectedSql, dataSchema, jsonContent, likeTerm, listSchema, notFound, nowSeconds, page, panelErrors }
