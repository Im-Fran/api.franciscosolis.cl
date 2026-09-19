import { SELF, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { TRANSLATION } from '@/lib/config'
import { clearDatabase } from '../helpers/db'
import { aiTranslation, stubAi, stubAiResponse } from '../helpers/ai'
import { asEditor } from '../helpers/tokens'

/**
 * `POST /admin/translate`.
 *
 * One route serves all three kinds of row here — an application page, a release note, a wiki page —
 * because the field name is all it is told. Its contract is unusual for this Worker and the tests
 * are shaped around it: a model that
 * fails is a 200 with `translation: null`, because the draft is an offer rather than a step in
 * saving a record. Only the caller's own mistakes — an empty field, an unknown field name, the same
 * locale twice — are errors.
 */

type Draft = {
  translation: string | null
  field: string
  source_locale: string
  target_locale: string
  model: string
}

let headers: Record<string, string>

const call = (body: unknown, init?: RequestInit) =>
  SELF.fetch('https://pages.internal/admin/translate', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    ...init,
  })

const dataOf = async <T>(response: Response) => (await response.json<{ data: T }>()).data

const countAiRequests = async () =>
  (await env.DB.prepare('SELECT COUNT(*) AS total FROM ai_requests').first<{ total: number }>())?.total ?? 0

beforeAll(async () => {
  headers = await asEditor()
})

beforeEach(clearDatabase)

describe('POST /admin/translate', () => {
  it('drafts a field and says which model produced it', async () => {
    const run = stubAiResponse(aiTranslation('Hola, mundo'))

    const draft = await dataOf<Draft>(await call({ text: 'Hello, world', field: 'title', target_locale: 'es' }))

    expect(draft.translation).toBe('Hola, mundo')
    expect(draft.field).toBe('title')
    expect(draft.source_locale).toBe('en')
    expect(draft.target_locale).toBe('es')
    expect(draft.model).toBe(env.AI_TEXT_MODEL)
    expect(run).toHaveBeenCalledOnce()
  })

  it('names both languages and the field in the prompt it sends', async () => {
    const run = stubAiResponse(aiTranslation('Resumen'))

    await call({ text: 'A summary', field: 'summary', target_locale: 'es' })

    const [, input] = run.mock.calls[0] ?? []
    const messages = (input as { messages: { role: string; content: string }[] }).messages
    const system = messages.find((message) => message.role === 'system')?.content ?? ''

    expect(system).toContain('English')
    expect(system).toContain('Spanish')
    expect(messages.at(-1)?.content).toBe('A summary')
  })

  it('tells the model to keep the Markdown structure of a body', async () => {
    const run = stubAiResponse(aiTranslation('## Título'))

    await call({ text: '## Title', field: 'body', target_locale: 'es' })

    const [, input] = run.mock.calls[0] ?? []
    const messages = (input as { messages: { role: string; content: string }[] }).messages
    expect(messages[0]?.content).toContain('Markdown')
  })

  it('writes nothing to the record it translated for', async () => {
    stubAiResponse(aiTranslation('Hola'))

    await call({ text: 'Hello', field: 'title', target_locale: 'es' })

    const rows = await env.DB.prepare('SELECT COUNT(*) AS total FROM applications').first<{ total: number }>()
    expect(rows?.total).toBe(0)
  })

  it('meters the call, successful or not', async () => {
    stubAiResponse(aiTranslation('Hola'))
    await call({ text: 'Hello', field: 'title', target_locale: 'es' })

    stubAi(async () => {
      throw new Error('the model is unavailable')
    })
    await call({ text: 'Hello again', field: 'title', target_locale: 'es' })

    expect(await countAiRequests()).toBe(2)

    const rows = await env.DB.prepare('SELECT kind, ok, actor_email FROM ai_requests ORDER BY ok DESC').all<{
      kind: string
      ok: number
      actor_email: string | null
    }>()
    expect(rows.results.map((row) => row.kind)).toEqual(['translate', 'translate'])
    expect(rows.results.map((row) => row.ok)).toEqual([1, 0])
    expect(rows.results[0]?.actor_email).toBe('fran@franciscosolis.cl')
  })

  it('answers 200 with a null translation when the model fails', async () => {
    stubAi(async () => {
      throw new Error('the model is unavailable')
    })

    const response = await call({ text: 'Hello', field: 'title', target_locale: 'es' })
    expect(response.status).toBe(200)
    expect((await dataOf<Draft>(response)).translation).toBeNull()
  })

  it('answers a null translation when the model ignores the schema', async () => {
    stubAiResponse({ response: 'Sure! Here is your translation: Hola' })

    expect((await dataOf<Draft>(await call({ text: 'Hello', field: 'title', target_locale: 'es' }))).translation)
      .toBeNull()
  })

  it('refuses a draft the API would reject on save', async () => {
    // Over the 120-character cap on an application's name. Offering it would hand the editor a
    // draft they cannot keep, which is worse than offering nothing.
    stubAiResponse(aiTranslation('á'.repeat(121)))

    expect((await dataOf<Draft>(await call({ text: 'Hello', field: 'name', target_locale: 'es' }))).translation)
      .toBeNull()
  })

  it('accepts a field from any of the three kinds of row it serves', async () => {
    stubAiResponse(aiTranslation('Hola'))

    for (const field of ['name', 'tagline', 'summary', 'overview_body', 'contact_body', 'title', 'body']) {
      const draft = await dataOf<Draft>(await call({ text: 'Hello', field, target_locale: 'es' }))
      expect(draft.field).toBe(field)
      expect(draft.translation).toBe('Hola')
    }
  })

  it('rejects an unknown field, a blank text and a source that is the target', async () => {
    expect((await call({ text: 'Hello', field: 'slug', target_locale: 'es' })).status).toBe(400)
    expect((await call({ text: '   ', field: 'title', target_locale: 'es' })).status).toBe(400)
    expect((await call({ text: 'Hello', field: 'title', target_locale: 'en' })).status).toBe(400)
    expect(
      (await call({ text: 'Hola', field: 'title', source_locale: 'es', target_locale: 'es' })).status,
    ).toBe(422)
    expect(await countAiRequests()).toBe(0)
  })

  it('rejects a source text longer than the service accepts', async () => {
    const response = await call({
      text: 'a'.repeat(TRANSLATION.maxSourceChars + 1),
      field: 'body',
      target_locale: 'es',
    })
    expect(response.status).toBe(400)
    expect(await countAiRequests()).toBe(0)
  })

  it('is behind the editor gate', async () => {
    const response = await SELF.fetch('https://pages.internal/admin/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello', field: 'title', target_locale: 'es' }),
    })
    expect(response.status).toBe(401)
  })

  it('refuses once the editor has spent their hourly allowance', async () => {
    const statement = env.DB.prepare(
      'INSERT INTO ai_requests (id, kind, model, actor_email, ok) VALUES (?, ?, ?, ?, 1)',
    )
    await env.DB.batch(
      Array.from({ length: TRANSLATION.hourlyLimitPerEditor }, (_value, index) =>
        statement.bind(`spent-${index}`, 'translate', 'model', 'fran@franciscosolis.cl'),
      ),
    )

    const response = await call({ text: 'Hello', field: 'title', target_locale: 'es' })
    expect(response.status).toBe(429)
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0)
  })
})
