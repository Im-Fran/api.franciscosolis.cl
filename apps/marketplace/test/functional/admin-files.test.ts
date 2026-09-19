import { SELF, env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_FILE_BYTES } from '@/lib/files'
import { clearDatabase, readAuditLog, seedProduct, seedReleaseFile, seedRelease } from '../helpers/db'
import { asEditor } from '../helpers/tokens'

const call = (path: string, init: RequestInit = {}) => SELF.fetch(`https://marketplace.test${path}`, init)

const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A product with a release to hang builds off. */
const seedContext = async () => {
  const product = await seedProduct({ slug: 'openbattery', name: 'OpenBattery' })
  const release = await seedRelease({ productId: product.id, version: '2.6.4' })
  return { product, release, base: `/admin/products/${product.id}/releases/${release.id}/files` }
}

describe('POST /admin/products/:id/releases/:releaseId/files', () => {
  beforeEach(clearDatabase)

  it('registers a build without any bytes yet', async () => {
    const { base } = await seedContext()

    const response = await call(base, {
      method: 'POST',
      headers: await asEditor(),
      body: JSON.stringify({ filename: 'app-2.6.4.jar', platform: 'server', label: 'Paper 1.21' }),
    })
    const { data } = (await response.json()) as { data: Record<string, unknown> }

    expect(response.status).toBe(201)
    expect(data).toMatchObject({ filename: 'app-2.6.4.jar', platform: 'server', has_content: false, status: 'draft' })
    // Nothing about the bucket reaches an editor either: the key is built from ids and stays internal.
    expect(data).not.toHaveProperty('object_key')
  })

  it('refuses two files with the same name on one release', async () => {
    const { base } = await seedContext()
    const headers = await asEditor()
    await call(base, { method: 'POST', headers, body: JSON.stringify({ filename: 'app.jar' }) })

    const response = await call(base, { method: 'POST', headers, body: JSON.stringify({ filename: 'app.jar' }) })
    expect(response.status).toBe(409)
  })

  it('refuses a filename carrying a path', async () => {
    const { base } = await seedContext()

    const response = await call(base, {
      method: 'POST',
      headers: await asEditor(),
      body: JSON.stringify({ filename: '../secrets.env' }),
    })
    // 400 rather than 422: the filename pattern is schema validation, and the validator answers first.
    expect(response.status).toBe(400)
  })

  it('needs an editor token', async () => {
    const { base } = await seedContext()

    expect((await call(base, { method: 'POST', body: '{}' })).status).toBe(401)
  })

  it('refuses a release belonging to another product', async () => {
    const { release } = await seedContext()
    const other = await seedProduct({ slug: 'elsewhere' })

    const response = await call(`/admin/products/${other.id}/releases/${release.id}/files`, {
      method: 'POST',
      headers: await asEditor(),
      body: JSON.stringify({ filename: 'app.jar' }),
    })
    expect(response.status).toBe(404)
  })
})

describe('PUT /admin/…/files/:id/content', () => {
  beforeEach(clearDatabase)

  it('streams the bytes into the bucket and measures them there', async () => {
    const { product, release, base } = await seedContext()
    const headers = await asEditor()
    const created = (await (
      await call(base, { method: 'POST', headers, body: JSON.stringify({ filename: 'app.jar' }) })
    ).json()) as { data: { id: string } }

    const response = await call(`${base}/${created.data.id}/content`, {
      method: 'PUT',
      headers: { Authorization: headers.Authorization },
      body: 'the-build-bytes',
    })
    const { data } = (await response.json()) as { data: Record<string, unknown> }

    expect(response.status).toBe(200)
    // The size comes off the stored object, not off a header the uploader wrote.
    expect(data).toMatchObject({ size: 'the-build-bytes'.length, has_content: true })

    const object = await env.RELEASES.get(`releases/${product.id}/${release.id}/${created.data.id}`)
    expect(await object?.text()).toBe('the-build-bytes')
  })

  it('stores a declared checksum for R2 to verify, and serves it on the download', async () => {
    const { base } = await seedContext()
    const headers = await asEditor()
    const created = (await (
      await call(base, { method: 'POST', headers, body: JSON.stringify({ filename: 'app.jar' }) })
    ).json()) as { data: { id: string } }

    const response = await call(`${base}/${created.data.id}/content`, {
      method: 'PUT',
      headers: { Authorization: headers.Authorization, 'X-Checksum-Sha256': await sha256('verified-bytes') },
      body: 'verified-bytes',
    })

    expect(response.status).toBe(200)
    expect(((await response.json()) as { data: { checksum: string } }).data.checksum).toBe(await sha256('verified-bytes'))
  })

  it('refuses bytes that do not match the declared checksum', async () => {
    const { base } = await seedContext()
    const headers = await asEditor()
    const created = (await (
      await call(base, { method: 'POST', headers, body: JSON.stringify({ filename: 'app.jar' }) })
    ).json()) as { data: { id: string } }

    const response = await call(`${base}/${created.data.id}/content`, {
      method: 'PUT',
      headers: { Authorization: headers.Authorization, 'X-Checksum-Sha256': await sha256('other-bytes') },
      body: 'the-build-bytes',
    })

    expect(response.status).toBe(400)
  })

  it('refuses an empty body', async () => {
    const { base } = await seedContext()
    const headers = await asEditor()
    const created = (await (
      await call(base, { method: 'POST', headers, body: JSON.stringify({ filename: 'app.jar' }) })
    ).json()) as { data: { id: string } }

    const response = await call(`${base}/${created.data.id}/content`, {
      method: 'PUT',
      headers: { Authorization: headers.Authorization },
      body: '',
    })
    expect(response.status).toBe(400)
  })

  it('refuses a declared length over the ceiling before storing anything', async () => {
    const { base } = await seedContext()
    const headers = await asEditor()
    const created = (await (
      await call(base, { method: 'POST', headers, body: JSON.stringify({ filename: 'app.jar' }) })
    ).json()) as { data: { id: string } }

    const response = await call(`${base}/${created.data.id}/content`, {
      method: 'PUT',
      headers: {
        Authorization: headers.Authorization,
        'Content-Length': String(MAX_FILE_BYTES + 1),
      },
      body: 'small',
    })
    expect(response.status).toBe(413)
  })

  it('writes the upload onto the audit trail', async () => {
    const { base } = await seedContext()
    const headers = await asEditor()
    const created = (await (
      await call(base, { method: 'POST', headers, body: JSON.stringify({ filename: 'app.jar' }) })
    ).json()) as { data: { id: string } }
    await call(`${base}/${created.data.id}/content`, {
      method: 'PUT',
      headers: { Authorization: headers.Authorization },
      body: 'bytes',
    })

    const trail = await readAuditLog()
    expect(trail.map((row) => row.event)).toContain('file.uploaded')
    expect(trail[0]?.actor_email).toBe('fran@franciscosolis.cl')
  })
})

describe('PATCH and DELETE /admin/…/files/:id', () => {
  beforeEach(clearDatabase)

  it('refuses to publish a file that has no bytes', async () => {
    const { product, release, base } = await seedContext()
    const file = await seedReleaseFile({ productId: product.id, releaseId: release.id, status: 'draft', uploadedAt: null })

    const response = await call(`${base}/${file.id}`, {
      method: 'PATCH',
      headers: await asEditor(),
      body: JSON.stringify({ status: 'published' }),
    })

    // The Releases tab would otherwise show a download that 404s.
    expect(response.status).toBe(422)
  })

  it('renames without moving any bytes', async () => {
    const { product, release, base } = await seedContext()
    const file = await seedReleaseFile({ productId: product.id, releaseId: release.id, filename: 'old.jar' })

    const response = await call(`${base}/${file.id}`, {
      method: 'PATCH',
      headers: await asEditor(),
      body: JSON.stringify({ filename: 'new.jar' }),
    })

    expect(response.status).toBe(200)
    // The object key is built from ids, so the object is exactly where it was.
    expect(await env.RELEASES.get(file.objectKey)).not.toBeNull()
  })

  it('deletes the row and the object together', async () => {
    const { product, release, base } = await seedContext()
    const file = await seedReleaseFile({ productId: product.id, releaseId: release.id })

    expect((await call(`${base}/${file.id}`, { method: 'DELETE', headers: await asEditor() })).status).toBe(204)
    expect(await env.RELEASES.get(file.objectKey)).toBeNull()
    const row = await env.DB.prepare('SELECT count(*) AS total FROM product_release_files').first<{ total: number }>()
    expect(row?.total).toBe(0)
  })

  it('takes the files with it when the product goes', async () => {
    const { product, release } = await seedContext()
    await seedReleaseFile({ productId: product.id, releaseId: release.id })

    expect(
      (await call(`/admin/products/${product.id}`, { method: 'DELETE', headers: await asEditor() })).status,
    ).toBe(204)

    // The foreign key cascade, which is what this schema has them for.
    const row = await env.DB.prepare('SELECT count(*) AS total FROM product_release_files').first<{ total: number }>()
    expect(row?.total).toBe(0)
  })
})
