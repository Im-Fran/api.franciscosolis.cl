import { SELF, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { EMAIL_LIMITS } from '@/lib/config'
import { clearDatabase, countRows, readAuditLog, seedTemplate } from '../helpers/db'
import { asEditor } from '../helpers/tokens'

type Template = {
  id: string
  slug: string
  name: string
  description: string | null
  subject: string
  html: string | null
  text: string | null
  variables: string[]
  created_by: string | null
  updated_by: string | null
}

let headers: Record<string, string>

const call = (method: string, path: string, body?: unknown) =>
  SELF.fetch(`https://cms.internal${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const dataOf = async <T>(response: Response) => (await response.json<{ data: T }>()).data
const errorOf = async (response: Response) => (await response.json<{ error: string }>()).error

const rawRow = (id: string) =>
  env.DB.prepare('SELECT slug, subject, html, text, variables, updated_by FROM email_templates WHERE id = ?')
    .bind(id)
    .first<{ slug: string; subject: string; html: string | null; text: string | null; variables: string; updated_by: string | null }>()

beforeAll(async () => {
  headers = await asEditor()
})

beforeEach(clearDatabase)

describe('GET /admin/email-templates', () => {
  it('lists templates ordered by name, with their variables parsed', async () => {
    await seedTemplate({ slug: 'welcome', name: 'Welcome', variables: '["name"]' })
    await seedTemplate({ slug: 'alert', name: 'Alert', variables: '[]' })

    const templates = await dataOf<Template[]>(await call('GET', '/admin/email-templates'))
    expect(templates.map((template) => template.slug)).toEqual(['alert', 'welcome'])
    expect(templates[1]?.variables).toEqual(['name'])
  })

  it('is never cached', async () => {
    expect((await call('GET', '/admin/email-templates')).headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('POST /admin/email-templates', () => {
  it('creates a template and derives its variables from the text', async () => {
    // The list is never declared by hand, so it cannot drift from the placeholders in use.
    const response = await call('POST', '/admin/email-templates', {
      name: 'Welcome Email',
      subject: 'Hola {{ name }}',
      html: '<p>{{ name }}, welcome to {{ site }}</p>',
      text: 'Hola {{ name }}',
    })
    const template = await dataOf<Template>(response)

    expect(response.status).toBe(201)
    expect(template).toMatchObject({
      slug: 'welcome-email',
      name: 'Welcome Email',
      variables: ['name', 'site'],
      created_by: 'fran@franciscosolis.cl',
    })
    expect(JSON.parse((await rawRow(template.id))?.variables ?? '[]')).toEqual(['name', 'site'])
  })

  it('records an empty variable list for a template with no placeholders', async () => {
    const template = await dataOf<Template>(
      await call('POST', '/admin/email-templates', { name: 'Fixed', subject: 'Static', text: 'Static body' }),
    )

    expect(template.variables).toEqual([])
  })

  it('accepts an html-only template and a text-only one alike', async () => {
    const htmlOnly = await dataOf<Template>(
      await call('POST', '/admin/email-templates', { name: 'Html only', subject: 'S', html: '<p>{{ a }}</p>' }),
    )
    const textOnly = await dataOf<Template>(
      await call('POST', '/admin/email-templates', { name: 'Text only', subject: 'S', text: '{{ b }}' }),
    )

    expect(htmlOnly).toMatchObject({ html: '<p>{{ a }}</p>', text: null, variables: ['a'] })
    expect(textOnly).toMatchObject({ html: null, text: '{{ b }}', variables: ['b'] })
  })

  it('accepts an explicit slug, normalised', async () => {
    const template = await dataOf<Template>(
      await call('POST', '/admin/email-templates', { name: 'Whatever', slug: '  Welcome  ', subject: 'S', text: 'T' }),
    )

    expect(template.slug).toBe('welcome')
  })

  it('422s a template with neither html nor text', async () => {
    const response = await call('POST', '/admin/email-templates', { name: 'Empty', subject: 'S' })

    expect(response.status).toBe(422)
    expect(await errorOf(response)).toBe('A template needs at least one of `html` or `text`')
  })

  it('treats an explicitly null or empty body as no body at all', async () => {
    expect((await call('POST', '/admin/email-templates', { name: 'A', subject: 'S', html: null, text: null })).status).toBe(422)
    expect((await call('POST', '/admin/email-templates', { name: 'B', subject: 'S', html: '', text: '' })).status).toBe(422)
  })

  it('422s when no slug can be derived from the name', async () => {
    const response = await call('POST', '/admin/email-templates', { name: '!!!', subject: 'S', text: 'T' })

    expect(response.status).toBe(422)
    expect(await errorOf(response)).toBe('Could not derive a slug from the name; send one explicitly')
  })

  it('409s a duplicate slug', async () => {
    await call('POST', '/admin/email-templates', { name: 'Welcome', subject: 'S', text: 'T' })
    const response = await call('POST', '/admin/email-templates', { name: 'Welcome', subject: 'S2', text: 'T2' })

    expect(response.status).toBe(409)
    expect(await errorOf(response)).toBe('A template with slug "welcome" already exists')
    expect(await countRows('email_templates')).toBe(1)
  })

  it('holds the subject to the EMAIL_LIMITS ceiling', async () => {
    const atLimit = 'x'.repeat(EMAIL_LIMITS.maxSubjectLength)
    expect((await call('POST', '/admin/email-templates', { name: 'A', subject: atLimit, text: 'T' })).status).toBe(201)
    expect((await call('POST', '/admin/email-templates', { name: 'B', subject: `${atLimit}x`, text: 'T' })).status).toBe(400)
  })

  it('holds a body to the EMAIL_LIMITS ceiling, html and text alike', async () => {
    const atLimit = 'x'.repeat(EMAIL_LIMITS.maxBodyLength)
    const tooLong = `${atLimit}x`

    expect((await call('POST', '/admin/email-templates', { name: 'A', subject: 'S', text: tooLong })).status).toBe(400)
    expect((await call('POST', '/admin/email-templates', { name: 'B', subject: 'S', html: tooLong })).status).toBe(400)
    expect((await call('POST', '/admin/email-templates', { name: 'C', subject: 'S', html: atLimit })).status).toBe(201)
    expect(await countRows('email_templates')).toBe(1)
  })

  it('holds a body to the same ceiling on update', async () => {
    const seeded = await seedTemplate({ slug: 'bounded', text: 'Short' })
    const tooLong = 'x'.repeat(EMAIL_LIMITS.maxBodyLength + 1)

    expect((await call('PATCH', `/admin/email-templates/${seeded.id}`, { html: tooLong })).status).toBe(400)
    expect((await call('PATCH', `/admin/email-templates/${seeded.id}`, { text: tooLong })).status).toBe(400)
    expect((await rawRow(seeded.id))?.text).toBe('Short')
  })

  it('400s an empty name or subject', async () => {
    expect((await call('POST', '/admin/email-templates', { name: '  ', subject: 'S', text: 'T' })).status).toBe(400)
    expect((await call('POST', '/admin/email-templates', { name: 'A', subject: '  ', text: 'T' })).status).toBe(400)
  })

  it('writes an audit row', async () => {
    const template = await dataOf<Template>(
      await call('POST', '/admin/email-templates', { name: 'Welcome', subject: 'S', text: 'T' }),
    )

    const [row] = await readAuditLog()
    expect(row?.event).toBe('email_template.created')
    expect(row?.resource_type).toBe('email_templates')
    expect(row?.resource_id).toBe(template.id)
    expect(row?.metadata).toEqual({ slug: 'welcome' })
  })
})

describe('GET /admin/email-templates/:id', () => {
  it('returns one template', async () => {
    const seeded = await seedTemplate({ slug: 'welcome', variables: '["name"]' })

    const template = await dataOf<Template>(await call('GET', `/admin/email-templates/${seeded.id}`))
    expect(template.slug).toBe('welcome')
    expect(template.variables).toEqual(['name'])
  })

  it('404s an id that does not exist', async () => {
    const response = await call('GET', '/admin/email-templates/nope')

    expect(response.status).toBe(404)
    expect(await errorOf(response)).toBe('Template not found')
  })
})

describe('PATCH /admin/email-templates/:id', () => {
  it('recomputes the variable list from the new text', async () => {
    const seeded = await seedTemplate({ subject: 'Hola {{ name }}', text: '{{ name }}', variables: '["name"]' })

    const template = await dataOf<Template>(
      await call('PATCH', `/admin/email-templates/${seeded.id}`, { text: 'Hola {{ name }} de {{ city }}' }),
    )

    expect(template.variables).toEqual(['name', 'city'])
    expect(JSON.parse((await rawRow(seeded.id))?.variables ?? '[]')).toEqual(['name', 'city'])
  })

  it('drops a variable that the new text no longer uses', async () => {
    const seeded = await seedTemplate({ subject: 'Hola {{ name }}', text: '{{ city }}', variables: '["name","city"]' })

    const template = await dataOf<Template>(
      await call('PATCH', `/admin/email-templates/${seeded.id}`, { subject: 'Hola', text: 'Fixed' }),
    )

    expect(template.variables).toEqual([])
  })

  it('leaves an omitted field alone and clears one sent as null', async () => {
    const seeded = await seedTemplate({ description: 'Set', html: '<p>Set</p>', text: 'Set' })

    const template = await dataOf<Template>(
      await call('PATCH', `/admin/email-templates/${seeded.id}`, { description: null, html: null }),
    )

    expect(template.description).toBeNull()
    expect(template.html).toBeNull()
    expect(template.text).toBe('Set')
  })

  it('422s an update that would leave the template with no body', async () => {
    const seeded = await seedTemplate({ html: null, text: 'Only body' })

    const response = await call('PATCH', `/admin/email-templates/${seeded.id}`, { text: null })

    expect(response.status).toBe(422)
    expect(await errorOf(response)).toBe('A template needs at least one of `html` or `text`')
    expect((await rawRow(seeded.id))?.text).toBe('Only body')
  })

  it('allows swapping one body for the other in a single call', async () => {
    const seeded = await seedTemplate({ html: null, text: 'Only body' })

    const response = await call('PATCH', `/admin/email-templates/${seeded.id}`, {
      text: null,
      html: '<p>Now html</p>',
    })

    expect(response.status).toBe(200)
    expect((await dataOf<Template>(response)).html).toBe('<p>Now html</p>')
  })

  it('409s when another template already uses the slug', async () => {
    await seedTemplate({ slug: 'taken' })
    const seeded = await seedTemplate({ slug: 'mine' })

    const response = await call('PATCH', `/admin/email-templates/${seeded.id}`, { slug: 'taken' })

    expect(response.status).toBe(409)
    expect(await errorOf(response)).toBe('A template with slug "taken" already exists')
    expect((await rawRow(seeded.id))?.slug).toBe('mine')
  })

  it('records the editor who touched it', async () => {
    const seeded = await seedTemplate({ updatedBy: 'someone-else@franciscosolis.cl' })

    await call('PATCH', `/admin/email-templates/${seeded.id}`, { name: 'Touched' })

    expect((await rawRow(seeded.id))?.updated_by).toBe('fran@franciscosolis.cl')
  })

  it('404s a template that does not exist', async () => {
    expect((await call('PATCH', '/admin/email-templates/nope', { name: 'X' })).status).toBe(404)
  })

  it('writes an audit row naming the fields that were sent', async () => {
    const seeded = await seedTemplate({ slug: 'welcome' })

    await call('PATCH', `/admin/email-templates/${seeded.id}`, { subject: 'New subject' })

    const [row] = await readAuditLog()
    expect(row?.event).toBe('email_template.updated')
    expect(row?.metadata).toEqual({ slug: 'welcome', fields: ['subject'] })
  })
})

describe('DELETE /admin/email-templates/:id', () => {
  it('deletes the template and answers 204', async () => {
    const seeded = await seedTemplate()

    const response = await call('DELETE', `/admin/email-templates/${seeded.id}`)

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(await countRows('email_templates')).toBe(0)
  })

  it('404s a template that does not exist', async () => {
    expect((await call('DELETE', '/admin/email-templates/nope')).status).toBe(404)
  })

  it('writes an audit row', async () => {
    const seeded = await seedTemplate({ slug: 'gone' })

    await call('DELETE', `/admin/email-templates/${seeded.id}`)

    const [row] = await readAuditLog()
    expect(row?.event).toBe('email_template.deleted')
    expect(row?.resource_id).toBe(seeded.id)
    expect(row?.metadata).toEqual({ slug: 'gone' })
  })
})
