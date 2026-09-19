import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { channelInput, type ReleaseChannel } from '@/lib/channels'
import { getDb } from '@/db/client'
import type { Database } from '@/db/client'
import type { AppEnv } from '@/env'
import { PUBLIC_CACHE_SECONDS } from '@/lib/config'
import { DownloadTicketError, mintDownloadTicket, verifyDownloadTicket } from '@/lib/downloads'
import { contentDisposition } from '@/lib/files'
import { optionalAccount } from '@/middleware/account'
import { GATE_MESSAGES, isChannelGated, resolveAccess } from '@/services/access'
import type { Product } from '@/services/products'
import { findProductById, findProductBySlug } from '@/services/products'
import { getRequestContext } from '@/services/audit'
import { recordDownload } from '@/services/downloads'
import { countDownload, findReleaseFileById, listReleaseFiles, toPublicReleaseFile } from '@/services/release-files'
import { findReleaseByVersion, findReleaseById } from '@/services/releases'

/**
 * The download path: what a release has attached to it, a ticket for one of those files, and the
 * bytes.
 *
 * **Why three steps instead of a link.** The bucket has no public access and nothing here ever hands
 * out an R2 URL. A listing says what exists; `POST …/download` is where the payment state of the
 * product is consulted and answered for *this* caller; and `GET /downloads/:ticket` serves bytes
 * against what that answer decided. A presigned URL cannot be asked whether the person holding it has
 * paid, and a public bucket cannot be asked anything at all.
 *
 * The cooldown lives in the ticket rather than in the page — see `src/lib/downloads.ts`. A non-payer's
 * ticket is simply not valid yet, so the five seconds cannot be skipped by anybody reading the
 * network tab.
 */
const app = new Hono<AppEnv>()

const requirePublishedProduct = async (db: Database, slug: string): Promise<Product> => {
  const product = await findProductBySlug(db, slug)
  if (!product || product.status !== 'published') {
    throw new HTTPException(404, { message: 'Product not found' })
  }
  return product
}

const fileSchema = v.looseObject({
  id: v.string(),
  filename: v.string(),
  size: v.number(),
  platform: v.string(),
})

const listResponseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    files: v.array(fileSchema),
    requires_payment: v.boolean(),
    /** Whether this *channel* is behind the purchase, which a stable build never is. */
    channel_requires_purchase: v.boolean(),
  }),
})

app.get(
  '/products/:slug/releases/:channel/:version/files',
  describeRoute({
    description:
      'The downloadable builds attached to a published release, with `requires_payment` saying whether a payment is needed to take one and `channel_requires_purchase` saying whether *this* channel is behind one. The listing itself is public on every channel — a visitor can always read what is in tonight\'s build, and what a pre-release may cost them is the download. No URLs: a download link is minted per request by `POST /products/:slug/files/:id/download`, because it carries who asked and whether they paid.',
    tags: ['Downloads'],
    responses: {
      200: { description: 'The files of the release', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      404: { description: 'No published product, or no published release on that channel with that version' },
    },
  }),
  validator('param', v.object({ slug: v.string(), channel: channelInput, version: v.string() })),
  async (c) => {
    const { channel, version } = c.req.valid('param')
    const db = getDb(c.env)
    const product = await requirePublishedProduct(db, c.req.param('slug'))

    const release = await findReleaseByVersion(db, product.id, channel, version)
    if (!release || release.status !== 'published') {
      throw new HTTPException(404, { message: 'Release not found' })
    }

    const files = await listReleaseFiles(db, { releaseId: release.id, status: 'published' })
    // Resolved for nobody in particular, which is what makes this cacheable: `gate` here is the
    // answer for a signed-out visitor, and it is the strictest one there is.
    const access = await resolveAccess(db, product, undefined, { release })

    // Cacheable: it is the same list for everybody. What differs per person is the ticket, and that
    // is a POST nothing caches.
    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({
      code: 200,
      data: {
        files: files.filter((file) => file.uploadedAt !== null).map(toPublicReleaseFile),
        requires_payment: access.pricing.requires_payment,
        channel_requires_purchase: isChannelGated(access.pricing, release.channel as ReleaseChannel),
      },
    })
  },
)

const ticketResponseSchema = v.object({
  code: v.literal(201),
  data: v.object({
    /** Absolute URL the browser follows to get the bytes. */
    url: v.string(),
    /** When it starts working. Now for a payer, five seconds out for everybody else. */
    available_at: v.string(),
    expires_at: v.string(),
    cooldown_seconds: v.number(),
    paid: v.boolean(),
  }),
})

app.post(
  '/products/:slug/files/:fileId/download',
  optionalAccount,
  describeRoute({
    description:
      'Mints a download link for one file. Send a Bearer access token from the website to be recognised as a buyer: a payer gets a link that works immediately, and everybody else gets one that works in five seconds. A paid product answers 402 without an approved payment, as does a pre-release build of a product that gates its pre-releases — the body\'s `gate` says which. That is the gate, and it is here rather than in the front-end.',
    tags: ['Downloads'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'The download link', content: { 'application/json': { schema: resolver(ticketResponseSchema) } } },
      402: { description: 'The product, or this channel of it, has to be paid for first' },
      404: { description: 'No published product, or no published file under that id' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const product = await requirePublishedProduct(db, c.req.param('slug'))

    const file = await findReleaseFileById(db, c.req.param('fileId'))
    // Scoped by the product in the URL, like every nested route here: an id from one product
    // must not be reachable through another's path. A file with no bytes yet is not a file.
    if (!file || file.productId !== product.id || file.status !== 'published' || file.uploadedAt === null) {
      throw new HTTPException(404, { message: 'File not found' })
    }

    // A published file on an unpublished release is still not public: the release is the thing that
    // was announced, and hiding it has to hide what hangs off it.
    const release = await findReleaseById(db, file.releaseId)
    if (!release || release.status !== 'published') {
      throw new HTTPException(404, { message: 'File not found' })
    }

    const access = await resolveAccess(db, product, c.get('account'), { release })
    if (!access.can_download && access.gate !== 'none') {
      // Returned rather than thrown, unlike every other refusal here, and for one reason: the body
      // carries `gate` as well as the sentence. "Buy this" and "support this to get the nightlies"
      // are different modals, and a front-end should not have to match on prose. `onError` builds
      // its body from the message alone, so a thrown HTTPException cannot carry the extra field.
      return c.json({ code: 402, error: GATE_MESSAGES[access.gate], gate: access.gate }, 402)
    }

    const { ticket, availableAt, expiresAt } = await mintDownloadTicket(c.env, {
      f: file.id,
      a: product.id,
      u: c.get('account')?.id ?? null,
      p: access.purchase?.id ?? null,
      // Snapshotted onto the ticket so `GET /downloads/:ticket` can log which line the build came
      // from without a second read. Not a trust boundary — the gate was decided here, at mint time.
      c: release.channel,
      paid: access.has_paid,
    })

    return c.json(
      {
        code: 201,
        data: {
          url: `${c.env.MARKETPLACE_PUBLIC_URL.replace(/\/+$/, '')}/downloads/${ticket}`,
          available_at: availableAt.toISOString(),
          expires_at: expiresAt.toISOString(),
          cooldown_seconds: access.cooldown_seconds,
          paid: access.has_paid,
        },
      },
      201,
    )
  },
)

/** Maps a ticket failure onto the status that says what actually happened. */
const ticketStatus = (error: DownloadTicketError) => {
  switch (error.reason) {
    case 'early':
      // 425 rather than 403: the link is good, it is just not time yet. A client can retry it as is.
      return 425
    case 'expired':
      return 410
    case 'signature':
      return 403
    default:
      return 400
  }
}

app.get(
  '/downloads/:ticket',
  describeRoute({
    description:
      'Serves the bytes of a file against a ticket from `POST /products/:slug/files/:id/download`. A ticket that is not valid yet answers 425 (the cooldown has not elapsed), an expired one 410 and a forged one 403. Range requests are honoured, so a download can be resumed.',
    tags: ['Downloads'],
    responses: {
      200: { description: 'The file' },
      206: { description: 'The requested byte range' },
      400: { description: 'The ticket is malformed' },
      403: { description: 'The ticket is not valid' },
      404: { description: 'The file is gone' },
      410: { description: 'The ticket has expired' },
      425: { description: 'The cooldown has not elapsed yet' },
    },
  }),
  async (c) => {
    let claims
    try {
      claims = await verifyDownloadTicket(c.env, c.req.param('ticket'))
    } catch (error) {
      if (error instanceof DownloadTicketError) {
        throw new HTTPException(ticketStatus(error), { message: error.message })
      }
      throw error
    }

    const db = getDb(c.env)
    const file = await findReleaseFileById(db, claims.f)
    if (!file || file.productId !== claims.a || file.status !== 'published' || file.uploadedAt === null) {
      throw new HTTPException(404, { message: 'File not found' })
    }

    // Read before the response rather than inside `waitUntil`: both are what the download is logged
    // as, and a log line that says which product and which version is the only thing that makes
    // the history readable once a release has been edited.
    const [product, release] = await Promise.all([
      findProductById(db, file.productId),
      findReleaseById(db, file.releaseId),
    ])

    const object = await c.env.RELEASES.get(file.objectKey, { range: c.req.raw.headers, onlyIf: c.req.raw.headers })
    if (!object) {
      // The row says there are bytes and the bucket disagrees. That is ours to fix, not the caller's.
      console.error('release file object is missing from the bucket', file.id, file.objectKey)
      throw new HTTPException(404, { message: 'File not found' })
    }

    const headers = new Headers({
      'Content-Type': file.contentType,
      'Content-Disposition': contentDisposition(file.filename),
      ETag: object.httpEtag,
      // A build is a build: the bytes under one id never change, so a client may keep them. It is
      // still `private` — the ticket in the URL is per person, and a shared cache keying on it would
      // be storing one buyer's download under one buyer's credential.
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      ...(file.checksum ? { 'X-Checksum-Sha256': file.checksum } : {}),
    })

    // `onlyIf` answering with no body is R2 saying the precondition failed, which for an
    // `If-None-Match` hit is a 304 and no transfer at all.
    if (!('body' in object)) {
      return c.body(null, 304, Object.fromEntries(headers))
    }

    const range = 'range' in object ? object.range : undefined
    const partial = range !== undefined && c.req.raw.headers.has('Range')

    if (partial && range && 'offset' in range) {
      const offset = range.offset ?? 0
      const length = range.length ?? object.size - offset
      headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`)
      headers.set('Content-Length', String(length))
    } else {
      headers.set('Content-Length', String(object.size))
      headers.set('Accept-Ranges', 'bytes')
    }

    // After the response, never before it: the bytes are already leaving, and neither the counter nor
    // the history is worth making somebody wait for.
    c.executionCtx.waitUntil(
      Promise.all([
        countDownload(db, file.id),
        recordDownload(db, {
          fileId: file.id,
          productId: file.productId,
          productSlug: product?.slug ?? '',
          releaseId: file.releaseId,
          version: release?.version ?? '',
          channel: claims.c ?? release?.channel ?? 'release',
          filename: file.filename,
          userId: claims.u,
          purchaseId: claims.p,
          paid: claims.paid,
          ...getRequestContext(c),
        }),
      ]),
    )

    return c.body(object.body, partial ? 206 : 200, Object.fromEntries(headers))
  },
)

export default app
