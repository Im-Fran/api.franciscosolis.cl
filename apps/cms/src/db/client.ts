import { drizzle } from 'drizzle-orm/d1'
import * as schema from '@/db/schema'
import type { Env } from '@/env'

/**
 * Builds a Drizzle client for the request's D1 binding. Cheap to call — it wraps the binding, it
 * does not open a connection — so handlers create one per request instead of sharing module state,
 * which would leak across requests in the Workers runtime.
 */
const getDb = (env: Env) => drizzle(env.DB, { schema })

type Database = ReturnType<typeof getDb>

export { getDb }
export type { Database }
