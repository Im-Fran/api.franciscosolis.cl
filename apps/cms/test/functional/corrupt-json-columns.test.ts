import { SELF, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDatabase, seedEntry } from '../helpers/db'
import { asEditor } from '../helpers/tokens'

/**
 * What a malformed JSON column does to a listing.
 *
 * Four columns in this Worker hold JSON as text and are parsed back on read. Exactly one of the
 * four call sites is guarded: `services/content.ts` wraps its `JSON.parse` in `parseJson` with a
 * comment saying a single bad row must not take the whole landing page down. The other three —
 * `email_templates.variables`, `audit_logs.metadata` and `email_messages.to_addresses` — parse
 * unguarded, so one corrupt blob 500s the entire listing it appears in.
 *
 * These tests pin the asymmetry as it stands today rather than the behaviour one would want:
 * the guarded path degrades, the three unguarded ones fail. Reported separately as a gap.
 */

let headers: Record<string, string>

const call = (path: string) => SELF.fetch(`https://cms.internal${path}`, { headers })

/** Silences the `onError` log the 500 path writes, and restores it afterwards. */
const withSilencedErrors = async <T>(body: () => Promise<T>): Promise<T> => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    return await body()
  } finally {
    spy.mockRestore()
  }
}

beforeAll(async () => {
  headers = await asEditor()
})

beforeEach(clearDatabase)

describe('the guarded call site', () => {
  it('serves an entry whose tags and data are unparseable, falling back to empty', async () => {
    await env.DB.prepare(
      "INSERT INTO content_entries (id, collection, slug, title, status, tags, data) VALUES (?, 'projects', 'corrupt', 'Corrupt', 'published', '{oops', 'not json')",
    )
      .bind(crypto.randomUUID())
      .run()

    const response = await SELF.fetch('https://cms.internal/content/projects')
    const body = await response.json<{ data: { slug: string; tags: string[]; data: unknown }[] }>()

    expect(response.status).toBe(200)
    expect(body.data[0]).toMatchObject({ slug: 'corrupt', tags: [], data: {} })
  })

  it('keeps the healthy rows of the listing alongside the corrupt one', async () => {
    // The point of the guard: one bad row must not cost the website every other entry.
    await seedEntry({ collection: 'projects', slug: 'healthy', tags: '["edge"]' })
    await env.DB.prepare(
      "INSERT INTO content_entries (id, collection, slug, title, status, tags, data) VALUES (?, 'projects', 'corrupt', 'Corrupt', 'published', '{oops', '{oops')",
    )
      .bind(crypto.randomUUID())
      .run()

    const body = await (await SELF.fetch('https://cms.internal/content/projects')).json<{
      data: { slug: string }[]
    }>()

    expect(body.data.map((entry) => entry.slug).sort()).toEqual(['corrupt', 'healthy'])
  })
})

describe('the unguarded call sites', () => {
  it('500s the whole email-template listing over one bad `variables` blob', async () => {
    await env.DB.prepare(
      "INSERT INTO email_templates (id, slug, name, subject, text, variables) VALUES ('bad', 'bad', 'Bad', 'S', 'T', '{oops')",
    ).run()

    const [listing, single] = await withSilencedErrors(async () => [
      await call('/admin/email-templates'),
      await call('/admin/email-templates/bad'),
    ])

    expect(listing.status).toBe(500)
    expect(await listing.json()).toEqual({ code: 500, error: 'Internal Server Error' })
    expect(single.status).toBe(500)
  })

  it('takes the healthy templates down with it', async () => {
    await env.DB.prepare(
      "INSERT INTO email_templates (id, slug, name, subject, text, variables) VALUES ('ok', 'ok', 'Ok', 'S', 'T', '[\"name\"]')",
    ).run()

    expect((await call('/admin/email-templates')).status).toBe(200)

    await env.DB.prepare(
      "INSERT INTO email_templates (id, slug, name, subject, text, variables) VALUES ('bad', 'bad', 'Bad', 'S', 'T', '{oops')",
    ).run()

    const response = await withSilencedErrors(() => call('/admin/email-templates'))
    expect(response.status).toBe(500)
  })

  it('500s the audit trail over one bad `metadata` blob', async () => {
    await env.DB.prepare("INSERT INTO audit_logs (id, event, metadata) VALUES ('bad', 'content.created', '{oops')").run()

    const response = await withSilencedErrors(() => call('/admin/audit'))

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ code: 500, error: 'Internal Server Error' })
  })

  it('500s the email log over one bad `to_addresses` blob', async () => {
    await env.DB.prepare(
      "INSERT INTO email_messages (id, to_addresses, from_email, subject, status) VALUES ('bad', 'not json', 'hola@mail.franciscosolis.cl', 'S', 'sent')",
    ).run()

    const [listing, single] = await withSilencedErrors(async () => [
      await call('/admin/emails'),
      await call('/admin/emails/bad'),
    ])

    expect(listing.status).toBe(500)
    expect(single.status).toBe(500)
  })

  it('says nothing about the row it choked on', async () => {
    // Whatever the shape of the failure, the 5xx rule still holds: no statement, no parameters,
    // no recipient addresses.
    await env.DB.prepare(
      "INSERT INTO email_messages (id, to_addresses, from_email, subject, status) VALUES ('bad', 'private@example.com', 'hola@mail.franciscosolis.cl', 'A private subject', 'sent')",
    ).run()

    const text = await withSilencedErrors(async () => (await call('/admin/emails')).text())

    expect(text).toBe(JSON.stringify({ code: 500, error: 'Internal Server Error' }))
    expect(text).not.toContain('private@example.com')
    expect(text).not.toContain('A private subject')
  })

  it('recovers as soon as the bad row is gone', async () => {
    await env.DB.prepare("INSERT INTO audit_logs (id, event, metadata) VALUES ('bad', 'content.created', '{oops')").run()
    expect((await withSilencedErrors(() => call('/admin/audit'))).status).toBe(500)

    await env.DB.prepare("DELETE FROM audit_logs WHERE id = 'bad'").run()
    expect((await call('/admin/audit')).status).toBe(200)
  })
})
