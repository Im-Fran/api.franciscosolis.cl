import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { appKeys } from '@/db/schema'
import type { Env } from '@/env'
import { APP_MODULES, type AppModule } from '@/lib/config'
import { parseJsonArray } from '@/lib/json'
import { hashToken, sriSha384 } from '@/lib/tokens'
import { renderSdk } from '@/services/sdk'
import { ingestUrls, type AppRow } from '@/services/serialize'

/** The modules an app has turned on, ignoring any value this version does not know. */
const modulesOf = (row: AppRow) =>
  parseJsonArray<AppModule>(row.modules).filter((module) => (APP_MODULES as readonly string[]).includes(module))

/**
 * The newest active key of an app: the one a freshly generated `sdk.js` embeds. Rotating a key
 * therefore changes the script — and its integrity hash — on the next request.
 */
const currentKey = async (env: Env, appId: string) =>
  (
    await getDb(env)
      .select()
      .from(appKeys)
      .where(and(eq(appKeys.appId, appId), eq(appKeys.status, 'active')))
      .orderBy(desc(appKeys.createdAt), desc(appKeys.id))
      .limit(1)
  )[0] ?? null

/**
 * An app's `sdk.js` with its integrity hash and ETag, or null when the app has no active key and so
 * nothing a script could enroll with. Shared by the ingest route that serves it and the panel route
 * that quotes the embed snippet, so the two can never disagree about the hash.
 */
const buildSdk = async (env: Env, appRow: AppRow) => {
  const key = await currentKey(env, appRow.id)
  if (!key) {
    return null
  }
  const script = renderSdk({
    appId: appRow.id,
    appKey: key.key,
    baseUrl: ingestUrls(env.INGEST_PUBLIC_URL, appRow.id).base_url,
    intervalSeconds: appRow.heartbeatIntervalSeconds,
    modules: modulesOf(appRow),
  })
  return { script, integrity: await sriSha384(script), etag: `"${(await hashToken(script)).slice(0, 32)}"` }
}

export { buildSdk, currentKey, modulesOf }
