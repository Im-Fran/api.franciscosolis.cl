import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { TRANSLATION } from '@/lib/config'
import { clearDatabase, firstRow } from '../helpers/db'
import { stubAi, stubAiResponse } from '../helpers/ai'
import { asAgent, asRequester } from '../helpers/tokens'

/**
 * `POST /admin/translate`.
 *
 * Same contract as the CMS's and the app pages' route, so the tests are shaped the same way: a
 * model that fails is a 200 with `translation: null`, because the draft is an offer rather than a
 * step in saving a record. Only the caller's own mistakes are errors.
 *
 * The one thing that is this Worker's alone is the gate: it is behind `support:admin`, not just the
 * email domain, so a perfectly valid requester token is refused here.
 */

type Draft = {
  translation: string | null
  field: string
  source_locale: string
  target_locale: string
  model: string
}

const call = async (body: unknown, headers?: Record<string, string>) =>
  SELF.fetch('https://support.test/admin/translate', {
    method: 'POST',
    headers: headers ?? (await asAgent()),
    body: JSON.stringify(body),
  })

const dataOf = async <T>(response: Response) => (await response.json<{ data: T }>()).data

/** What Workers AI returns for a JSON-mode text model: the answer as a string under `response`. */
const aiTranslation = (translation: string) => ({ response: JSON.stringify({ translation }) })

const countAiRequests = async () =>
  (await firstRow<{ total: number }>('SELECT COUNT(*) AS total FROM ai_requests'))?.total ?? 0

beforeEach(clearDatabase)

describe('POST /admin/translate', () => {
  it('drafts a field and says which model produced it', async () => {
    const run = stubAiResponse(aiTranslation('Por qué el enlace no llega'))

    const draft = await dataOf<Draft>(
      await call({ text: 'Why the sign-in link never arrives', field: 'title', target_locale: 'es' }),
    )

    expect(draft.translation).toBe('Por qué el enlace no llega')
    expect(draft.field).toBe('title')
    expect(draft.source_locale).toBe('en')
    expect(draft.target_locale).toBe('es')
    expect(draft.model).toBe(env.AI_TEXT_MODEL)
    expect(run).toHaveBeenCalledOnce()
  })

  it('names both languages in the prompt and hands over the source untouched', async () => {
    const run = stubAiResponse(aiTranslation('Resumen'))

    await call({ text: 'A summary', field: 'summary', target_locale: 'es' })

    const [, input] = run.mock.calls[0] ?? []
    const messages = (input as { messages: { role: string; content: string }[] }).messages
    expect(messages[0]?.content).toContain('English')
    expect(messages[0]?.content).toContain('Spanish')
    expect(messages.at(-1)?.content).toBe('A summary')
  })

  it('tells the model to keep the Markdown structure of an article body', async () => {
    const run = stubAiResponse(aiTranslation('## Título'))

    await call({ text: '## Title', field: 'body', target_locale: 'es' })

    const [, input] = run.mock.calls[0] ?? []
    const messages = (input as { messages: { content: string }[] }).messages
    expect(messages[0]?.content).toContain('Markdown')
  })

  it('writes no article, no index row and no vector', async () => {
    stubAiResponse(aiTranslation('Hola'))

    await call({ text: 'Hello', field: 'title', target_locale: 'es' })

    expect((await firstRow<{ total: number }>('SELECT COUNT(*) AS total FROM help_articles'))?.total).toBe(0)
  })

  it('meters the call under its own kind, successful or not', async () => {
    stubAiResponse(aiTranslation('Hola'))
    await call({ text: 'Hello', field: 'title', target_locale: 'es' })

    stubAi(async () => {
      throw new Error('the model is unavailable')
    })
    await call({ text: 'Hello again', field: 'title', target_locale: 'es' })

    expect(await countAiRequests()).toBe(2)
    const kinds = await env.DB.prepare('SELECT kind, ok FROM ai_requests ORDER BY ok DESC').all<{
      kind: string
      ok: number
    }>()
    expect(kinds.results.map((row) => row.kind)).toEqual(['translate', 'translate'])
    expect(kinds.results.map((row) => row.ok)).toEqual([1, 0])
  })

  it('answers 200 with a null translation when the model fails or ignores the schema', async () => {
    stubAi(async () => {
      throw new Error('the model is unavailable')
    })
    const failed = await call({ text: 'Hello', field: 'title', target_locale: 'es' })
    expect(failed.status).toBe(200)
    expect((await dataOf<Draft>(failed)).translation).toBeNull()

    stubAiResponse({ response: 'Sure! Here is your translation: Hola' })
    expect((await dataOf<Draft>(await call({ text: 'Hello', field: 'title', target_locale: 'es' }))).translation)
      .toBeNull()
  })

  it('refuses a draft the API would reject on save', async () => {
    // Over the 60-character cap a label's name carries, which is the smaller of the two caps this
    // route knows for `name`. Offering it would hand the editor a draft they cannot keep.
    stubAiResponse(aiTranslation('á'.repeat(61)))

    expect((await dataOf<Draft>(await call({ text: 'Billing', field: 'name', target_locale: 'es' }))).translation)
      .toBeNull()
  })

  it('accepts a field from any of the three kinds of row it serves', async () => {
    stubAiResponse(aiTranslation('Hola'))

    for (const field of ['title', 'summary', 'body', 'name', 'description']) {
      const draft = await dataOf<Draft>(await call({ text: 'Hello', field, target_locale: 'es' }))
      expect(draft.field).toBe(field)
      expect(draft.translation).toBe('Hola')
    }
  })

  it('rejects an unknown field, a blank text, an over-long source and a no-op locale pair', async () => {
    expect((await call({ text: 'Hello', field: 'slug', target_locale: 'es' })).status).toBe(400)
    expect((await call({ text: '   ', field: 'title', target_locale: 'es' })).status).toBe(400)
    expect((await call({ text: 'Hello', field: 'title', target_locale: 'en' })).status).toBe(400)
    expect(
      (await call({ text: 'a'.repeat(TRANSLATION.maxSourceChars + 1), field: 'body', target_locale: 'es' })).status,
    ).toBe(400)
    expect(
      (await call({ text: 'Hola', field: 'title', source_locale: 'es', target_locale: 'es' })).status,
    ).toBe(422)
    expect(await countAiRequests()).toBe(0)
  })

  it('is behind support:admin, not just the email domain', async () => {
    expect(
      (
        await SELF.fetch('https://support.test/admin/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'Hello', field: 'title', target_locale: 'es' }),
        })
      ).status,
    ).toBe(401)

    // An agent of the right domain who simply does not hold the permission.
    const unprivileged = await call(
      { text: 'Hello', field: 'title', target_locale: 'es' },
      await asAgent({ permissions: ['support:agent'] }),
    )
    expect(unprivileged.status).toBe(403)

    // A website token never reaches the permission check at all: its audience is not the console's.
    const requester = await call({ text: 'Hello', field: 'title', target_locale: 'es' }, await asRequester())
    expect(requester.status).toBe(401)

    expect(await countAiRequests()).toBe(0)
  })

  it('refuses once the agent has spent their hourly allowance, and keeps the assistant\'s apart', async () => {
    const statement = env.DB.prepare(
      'INSERT INTO ai_requests (id, kind, model, actor_email, ok) VALUES (?, ?, ?, ?, 1)',
    )
    await env.DB.batch(
      Array.from({ length: TRANSLATION.hourlyLimitPerAgent }, (_value, index) =>
        statement.bind(`spent-${index}`, 'assist', 'model', 'fran@franciscosolis.cl'),
      ),
    )

    // Spent on the assistant, so the translation allowance is untouched.
    stubAiResponse(aiTranslation('Hola'))
    expect((await call({ text: 'Hello', field: 'title', target_locale: 'es' })).status).toBe(200)

    await env.DB.batch(
      Array.from({ length: TRANSLATION.hourlyLimitPerAgent }, (_value, index) =>
        statement.bind(`translated-${index}`, 'translate', 'model', 'fran@franciscosolis.cl'),
      ),
    )

    const response = await call({ text: 'Hello', field: 'title', target_locale: 'es' })
    expect(response.status).toBe(429)
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0)
  })
})
