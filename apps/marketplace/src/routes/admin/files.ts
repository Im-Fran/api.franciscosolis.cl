import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { Database } from '@/db/client'
import { productReleaseFiles } from '@/db/schema'
import type { AppEnv } from '@/env'
import { CONTENT_STATUS } from '@/lib/config'
import { asConflict } from '@/lib/errors'
import {
  filenameInput,
  MAX_FILE_BYTES,
  MAX_FILES_PER_RELEASE,
  objectKeyFor,
  RELEASE_FILE_PLATFORMS,
} from '@/lib/files'
import { optionalText } from '@/lib/validation'
import type { Product } from '@/services/products'
import { findProductById } from '@/services/products'
import { getActorContext, getRequestContext, recordAudit } from '@/services/audit'
import { findReleaseFileById, listReleaseFiles, toAdminReleaseFile } from '@/services/release-files'
import { findReleaseById, type ProductRelease } from '@/services/releases'

/**
 * Editorial API for the builds attached to a release note.
 *
 * **Metadata and bytes are two requests, and that is deliberate.** `POST` writes the row and answers
 * its id; `PUT …/content` streams the bytes into R2 against that id. Doing both in one multipart
 * request would mean buffering a 90 MB installer to parse a form — a Worker has 128 MB of memory —
 * and it would leave no way to replace a file's bytes without recreating the row that a published
 * release already links to.
 *
 * The bytes are streamed rather than read, for the same memory reason. Nothing here ever holds a
 * whole build: `env.RELEASES.put` takes the request body as a stream, and the size comes back off the
 * stored object rather than from a header the uploader wrote.
 */
const app = new Hono<AppEnv>()

const requireProduct = async (db: Database, id: string): Promise<Product> => {
  const product = await findProductById(db, id)
  if (!product) {
    throw new HTTPException(404, { message: 'Product not found' })
  }
  return product
}

/** Reads `:releaseId` as a release of `product`, so an id from another one is a 404 here. */
const requireRelease = async (db: Database, product: Product, id: string): Promise<ProductRelease> => {
  const release = await findReleaseById(db, id)
  if (!release || release.productId !== product.id) {
    throw new HTTPException(404, { message: 'Release not found' })
  }
  return release
}

const requireFile = async (db: Database, release: ProductRelease, id: string) => {
  const file = await findReleaseFileById(db, id)
  if (!file || file.releaseId !== release.id) {
    throw new HTTPException(404, { message: 'File not found' })
  }
  return file
}

const fileSchema = v.looseObject({ id: v.string(), filename: v.string(), status: v.string(), has_content: v.boolean() })
const listResponseSchema = v.object({ code: v.literal(200), data: v.array(fileSchema) })
const itemResponseSchema = v.object({ code: v.literal(200), data: fileSchema })

const BASE = '/products/:productId/releases/:releaseId/files'

app.get(
  BASE,
  describeRoute({
    description: 'The builds attached to a release, in editor order, drafts and unfinished uploads included.',
    tags: ['Admin · Downloads'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The files', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product or release' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))
    const release = await requireRelease(db, product, c.req.param('releaseId'))

    const rows = await listReleaseFiles(db, { releaseId: release.id })
    return c.json({ code: 200, data: rows.map(toAdminReleaseFile) })
  },
)

const createSchema = v.object({
  filename: filenameInput,
  content_type: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(120))),
  platform: v.optional(v.picklist(RELEASE_FILE_PLATFORMS)),
  label: optionalText(80),
  position: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(999))),
  status: v.optional(v.picklist(CONTENT_STATUS)),
})

app.post(
  BASE,
  describeRoute({
    description:
      'Registers a build on a release and answers its id. The bytes go up separately with `PUT …/files/:id/content`; until they do, the row is metadata and the public routes ignore it. The filename must be unique within the release.',
    tags: ['Admin · Downloads'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'The created file', content: { 'application/json': { schema: resolver(itemResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product or release' },
      409: { description: 'That filename already exists on the release' },
      422: { description: 'The body failed validation, or the release is full' },
    },
  }),
  validator('json', createSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()

    const product = await requireProduct(db, c.req.param('productId'))
    const release = await requireRelease(db, product, c.req.param('releaseId'))

    const existing = await listReleaseFiles(db, { releaseId: release.id })
    if (existing.length >= MAX_FILES_PER_RELEASE) {
      throw new HTTPException(422, { message: `A release may carry at most ${MAX_FILES_PER_RELEASE} files` })
    }

    const id = crypto.randomUUID()
    const row = {
      id,
      productId: product.id,
      releaseId: release.id,
      // Built from ids, never from the filename: a rename is then a column change, and nothing an
      // editor types can name an object outside its own prefix.
      objectKey: objectKeyFor(product.id, release.id, id),
      filename: body.filename,
      contentType: body.content_type ?? 'application/octet-stream',
      size: 0,
      checksum: null,
      platform: body.platform ?? 'any',
      label: body.label ?? null,
      position: body.position ?? existing.length,
      status: body.status ?? 'draft',
      uploadedAt: null,
      downloadCount: 0,
      createdBy: editor.email,
      updatedBy: editor.email,
      createdAt: now,
      updatedAt: now,
    }

    try {
      await db.insert(productReleaseFiles).values(row)
    } catch (error) {
      throw asConflict(error, `A file named "${body.filename}" already exists on this release`)
    }

    await recordAudit(db, {
      event: 'file.created',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'product_release_files',
      resourceId: id,
      metadata: { product: product.slug, version: release.version, filename: row.filename },
    })

    return c.json({ code: 201, data: toAdminReleaseFile(row) }, 201)
  },
)

app.put(
  `${BASE}/:id/content`,
  describeRoute({
    description:
      'Uploads the bytes of a registered build. The body is the file itself — not a form — and it is streamed into the bucket rather than read, so an installer never has to fit in the Worker\'s memory. Send `X-Checksum-Sha256` with the digest to have R2 verify it and store it on the row for anybody downloading later.',
    tags: ['Admin · Downloads'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The stored file', content: { 'application/json': { schema: resolver(itemResponseSchema) } } },
      400: { description: 'The body was empty, or the declared checksum did not match the bytes' },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product, release or file' },
      413: { description: 'The file is larger than the limit' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()

    const product = await requireProduct(db, c.req.param('productId'))
    const release = await requireRelease(db, product, c.req.param('releaseId'))
    const file = await requireFile(db, release, c.req.param('id'))

    // The declared length is a hint checked before anything is stored; the measured one below is the
    // fact. Both are checked, because only one of them can be trusted and only one of them is cheap.
    const declared = Number(c.req.header('Content-Length') ?? '0')
    if (declared > MAX_FILE_BYTES) {
      throw new HTTPException(413, { message: `A file must be at most ${MAX_FILE_BYTES} bytes` })
    }

    const body = c.req.raw.body
    if (!body) {
      throw new HTTPException(400, { message: 'The request body is the file; it cannot be empty' })
    }

    const checksum = c.req.header('X-Checksum-Sha256')?.trim().toLowerCase()
    if (checksum !== undefined && !/^[0-9a-f]{64}$/.test(checksum)) {
      throw new HTTPException(400, { message: 'X-Checksum-Sha256 must be a hex SHA-256 digest' })
    }

    let object
    try {
      object = await c.env.RELEASES.put(file.objectKey, body, {
        httpMetadata: { contentType: file.contentType },
        // R2 verifies this itself and refuses the upload on a mismatch, which is a stronger check than
        // anything this Worker could do without holding the whole file in memory.
        ...(checksum ? { sha256: checksum } : {}),
      })
    } catch (error) {
      console.error('failed to store a release file', file.id, error)
      throw new HTTPException(400, { message: 'The upload failed; the bytes did not match the declared checksum' })
    }
    if (!object) {
      throw new HTTPException(400, { message: 'The upload failed' })
    }

    if (object.size === 0 || object.size > MAX_FILE_BYTES) {
      // Stored before it could be measured, so it is removed again rather than left as a row claiming
      // to have content.
      await c.env.RELEASES.delete(file.objectKey)
      throw new HTTPException(object.size === 0 ? 400 : 413, {
        message:
          object.size === 0
            ? 'The request body is the file; it cannot be empty'
            : `A file must be at most ${MAX_FILE_BYTES} bytes`,
      })
    }

    const updated = {
      ...file,
      size: object.size,
      checksum: checksum ?? file.checksum,
      uploadedAt: now,
      updatedBy: editor.email,
      updatedAt: now,
    }

    await db
      .update(productReleaseFiles)
      .set({
        size: updated.size,
        checksum: updated.checksum,
        uploadedAt: updated.uploadedAt,
        updatedBy: updated.updatedBy,
        updatedAt: updated.updatedAt,
      })
      .where(eq(productReleaseFiles.id, file.id))

    await recordAudit(db, {
      event: 'file.uploaded',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'product_release_files',
      resourceId: file.id,
      metadata: { product: product.slug, version: release.version, filename: file.filename, size: object.size },
    })

    return c.json({ code: 200, data: toAdminReleaseFile(updated) })
  },
)

const patchSchema = v.object({
  filename: v.optional(filenameInput),
  content_type: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(120))),
  platform: v.optional(v.picklist(RELEASE_FILE_PLATFORMS)),
  label: optionalText(80),
  position: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(999))),
  status: v.optional(v.picklist(CONTENT_STATUS)),
})

app.patch(
  `${BASE}/:id`,
  describeRoute({
    description:
      'Updates a build\'s metadata. Renaming only changes what a browser saves the file as — the object key is built from ids, so no bytes move. A file with no upload yet cannot be published: the Releases tab would show a download that 404s.',
    tags: ['Admin · Downloads'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The updated file', content: { 'application/json': { schema: resolver(itemResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product, release or file' },
      409: { description: 'Another file on the release already uses that filename' },
      422: { description: 'The body failed validation, or the file has no content to publish' },
    },
  }),
  validator('json', patchSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()

    const product = await requireProduct(db, c.req.param('productId'))
    const release = await requireRelease(db, product, c.req.param('releaseId'))
    const current = await requireFile(db, release, c.req.param('id'))

    const status = body.status ?? current.status
    if (status === 'published' && current.uploadedAt === null) {
      throw new HTTPException(422, { message: 'This file has no content yet, so it cannot be published' })
    }

    const updated = {
      ...current,
      filename: body.filename ?? current.filename,
      contentType: body.content_type ?? current.contentType,
      platform: body.platform ?? current.platform,
      label: body.label === undefined ? current.label : body.label,
      position: body.position ?? current.position,
      status,
      updatedBy: editor.email,
      updatedAt: now,
    }

    try {
      await db
        .update(productReleaseFiles)
        .set({
          filename: updated.filename,
          contentType: updated.contentType,
          platform: updated.platform,
          label: updated.label,
          position: updated.position,
          status: updated.status,
          updatedBy: updated.updatedBy,
          updatedAt: updated.updatedAt,
        })
        .where(eq(productReleaseFiles.id, current.id))
    } catch (error) {
      throw asConflict(error, `A file named "${updated.filename}" already exists on this release`)
    }

    await recordAudit(db, {
      event: 'file.updated',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'product_release_files',
      resourceId: current.id,
      metadata: { product: product.slug, version: release.version, fields: Object.keys(body), status },
    })

    return c.json({ code: 200, data: toAdminReleaseFile(updated) })
  },
)

app.delete(
  `${BASE}/:id`,
  describeRoute({
    description:
      'Deletes a build and its bytes. The object goes first and the row second: a row with no object is a download that 404s, while an object with no row is unreachable and costs storage — the second is the failure worth having.',
    tags: ['Admin · Downloads'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The file was deleted' },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product, release or file' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))
    const release = await requireRelease(db, product, c.req.param('releaseId'))
    const file = await requireFile(db, release, c.req.param('id'))

    await c.env.RELEASES.delete(file.objectKey)
    await db.delete(productReleaseFiles).where(eq(productReleaseFiles.id, file.id))

    await recordAudit(db, {
      event: 'file.deleted',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'product_release_files',
      resourceId: file.id,
      metadata: { product: product.slug, version: release.version, filename: file.filename },
    })

    return c.body(null, 204)
  },
)

export default app
