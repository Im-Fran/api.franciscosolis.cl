import type { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import type { Env } from '@/env'

/**
 * The FranciscoSolis horizontal lockup, base64-encoded, so the gateway can serve it.
 *
 * It lives here — in a proxy that otherwise owns no content of its own — because the templates in
 * `@franciscosolis/emails` need the logo at an absolute, permanently reachable URL, and this Worker
 * is the only thing in the repository with a public hostname. An email cannot carry the logo any
 * other way: Gmail blocks `data:` URIs outright and strips inline SVG, so it has to be a real HTTP
 * asset.
 *
 * The bytes are inlined rather than configured as Wrangler static assets on purpose. 5 KB costs
 * nothing in a bundle, and keeping them here means the asset ships in the same deploy as the route
 * that serves it and is covered by the same test run, with no second deploy target to keep in sync.
 *
 * Source of truth is `packages/emails/assets/lockup.png` — a 400×66 (2×) render of
 * `fs-lockup-horizontal` from the brand package, flattened onto white. Regenerating it means
 * re-encoding here too; `packages/emails/README.md` has the one-liner.
 */
const LOCKUP_PNG_BASE64 = [
  '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',
  'RU5ErkJggg==',
].join('')

/** Decoded once per isolate, not once per request. */
const LOCKUP_PNG = Uint8Array.from(atob(LOCKUP_PNG_BASE64), (character) => character.charCodeAt(0))

/**
 * FNV-1a over the decoded bytes.
 *
 * Derived rather than written down so that swapping the asset cannot leave a stale validator
 * behind: a hand-maintained ETag is one forgotten edit away from telling every cache in the path
 * that a logo which did change did not.
 */
const etagOf = (bytes: Uint8Array): string => {
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  }
  return `"${hash.toString(16)}-${bytes.byteLength.toString(16)}"`
}

const LOCKUP_ETAG = etagOf(LOCKUP_PNG)

/**
 * A week, and deliberately not `immutable`.
 *
 * The URL is fixed and the brand behind it is not: an `immutable` year would mean a corrected logo
 * never reaching a recipient whose client already cached the old one. A week plus the ETag gives
 * caches a cheap revalidation and the brand a bounded worst case.
 */
const LOCKUP_CACHE_CONTROL = 'public, max-age=604800'

/**
 * Mounts `GET /brand/lockup.png`.
 *
 * Registered as its own function, alongside `registerServiceProxies`, so `src/index.ts` stays a
 * list of what the gateway exposes rather than a place where payloads live.
 */
const registerBrandAssets = (app: Hono<{ Bindings: Env }>) => {
  app.get(
    '/brand/lockup.png',
    describeRoute({
      description: 'The FranciscoSolis horizontal lockup, as referenced by the emails this API sends',
      tags: ['General'],
      responses: {
        200: {
          description: 'The lockup, as a 400×66 PNG',
          content: { 'image/png': { schema: { type: 'string', format: 'binary' } } },
        },
        304: {
          description: 'The caller already holds this version of the lockup',
        },
      },
    }),
    (c) => {
      if (c.req.header('If-None-Match') === LOCKUP_ETAG) {
        return c.body(null, 304, { ETag: LOCKUP_ETAG, 'Cache-Control': LOCKUP_CACHE_CONTROL })
      }

      return c.body(LOCKUP_PNG.buffer as ArrayBuffer, 200, {
        'Content-Type': 'image/png',
        'Content-Length': String(LOCKUP_PNG.byteLength),
        'Cache-Control': LOCKUP_CACHE_CONTROL,
        ETag: LOCKUP_ETAG,
      })
    },
  )
}

export { LOCKUP_CACHE_CONTROL, LOCKUP_ETAG, LOCKUP_PNG, registerBrandAssets }
