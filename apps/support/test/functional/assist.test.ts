import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ASSIST, EMBEDDING } from '@/lib/config'
import { allRows, clearDatabase, firstRow } from '../helpers/db'
import { stubAi, stubVectorize } from '../helpers/ai'
import { asAgent } from '../helpers/tokens'

const call = (path: string, init: RequestInit = {}) => SELF.fetch(`https://support.test${path}`, init)

const vector = () => Array.from({ length: EMBEDDING.dimensions }, () => 0.01)

/** An `env.AI.run` that answers an embedding call with a vector and a text call with `answer`. */
const stubAiWith = (answer: unknown) =>
  stubAi(async (model, input) => {
    if ('text' in input) {
      return { data: [vector()] }
    }
    return answer
  })

const publishArticle = async (overrides: Record<string, unknown> = {}) => {
  const response = await call('/admin/help/articles', {
    method: 'POST',
    headers: await asAgent(),
    body: JSON.stringify({
      title: 'Why the sign-in link never arrives',
      summary: 'Check spam, then ask us to resend it.',
      body: 'Most providers file the first message from a new sender as spam.',
      status: 'published',
      ...overrides,
    }),
  })
  return (await response.json()) as { data: { id: string; slug: string } }
}

const ask = async (query = 'the link never arrives') =>
  call('/admin/assist', {
    method: 'POST',
    headers: await asAgent(),
    body: JSON.stringify({ query }),
  })

beforeEach(async () => {
  await clearDatabase()
  // Embeddings are stubbed for the publish path in every test here; the retrieval side is set per
  // test because that is what each one is about.
  stubAiWith({ response: '{}' })
  stubVectorize({ query: vi.fn(async () => ({ matches: [] })) })
})

describe('POST /admin/assist', () => {
  it('drafts an answer from the articles it retrieved, and cites them', async () => {
    const article = await publishArticle()
    stubVectorize({
      query: vi.fn(async () => ({
        matches: [{ id: `${article.data.id}:en:0`, score: 0.82, metadata: { article_id: article.data.id } }],
      })),
    })
    stubAiWith({
      response: JSON.stringify({
        answer: 'Most providers file our first message as spam. Check that folder, then ask us to resend it.',
        cited_slugs: [article.data.slug],
        confidence: 'high',
        insufficient_context: false,
      }),
    })

    const response = await ask()
    expect(response.status).toBe(200)

    const body = (await response.json()) as {
      data: { answer: string | null; sources: Array<{ slug: string }>; insufficient_context: boolean }
    }
    expect(body.data.answer).toContain('spam')
    expect(body.data.insufficient_context).toBe(false)
    expect(body.data.sources.map((source) => source.slug)).toEqual([article.data.slug])
  })

  it('never calls the text model when nothing was retrieved', async () => {
    await publishArticle()
    const run = stubAiWith({ response: '{}' })
    stubVectorize({ query: vi.fn(async () => ({ matches: [] })) })

    const response = await ask()
    const body = (await response.json()) as { data: { answer: string | null; insufficient_context: boolean } }

    expect(body.data.answer).toBeNull()
    expect(body.data.insufficient_context).toBe(true)
    // The cheapest and most honest guard there is: no sources, no model call, no invented answer.
    const textCalls = run.mock.calls.filter(([, input]) => 'messages' in (input as Record<string, unknown>))
    expect(textCalls).toHaveLength(0)
  })

  it('drops a match whose score is below the floor', async () => {
    const article = await publishArticle()
    stubVectorize({
      query: vi.fn(async () => ({
        matches: [{ id: `${article.data.id}:en:0`, score: ASSIST.minScore - 0.1, metadata: { article_id: article.data.id } }],
      })),
    })

    const body = (await (await ask()).json()) as { data: { insufficient_context: boolean } }
    expect(body.data.insufficient_context).toBe(true)
  })

  it('never lets an unpublished article reach the prompt', async () => {
    const article = await publishArticle()
    await call(`/admin/help/articles/${article.data.id}`, {
      method: 'PATCH',
      headers: await asAgent(),
      body: JSON.stringify({ status: 'draft' }),
    })

    // A stale vector pointing at a draft is exactly what Vectorize and D1 not being transactional
    // produces. The article is always re-read from D1, which is why that costs a wasted slot in a
    // top-k rather than leaking an unpublished draft.
    stubVectorize({
      query: vi.fn(async () => ({
        matches: [{ id: `${article.data.id}:en:0`, score: 0.9, metadata: { article_id: article.data.id } }],
      })),
    })

    const body = (await (await ask()).json()) as { data: { insufficient_context: boolean; sources: unknown[] } }
    expect(body.data.insufficient_context).toBe(true)
    expect(body.data.sources).toEqual([])
  })

  it('strips a citation the model invented', async () => {
    const article = await publishArticle()
    stubVectorize({
      query: vi.fn(async () => ({
        matches: [{ id: `${article.data.id}:en:0`, score: 0.8, metadata: { article_id: article.data.id } }],
      })),
    })
    stubAiWith({
      response: JSON.stringify({
        answer: 'See our refund policy.',
        cited_slugs: ['refund-policy', article.data.slug],
        confidence: 'high',
        insufficient_context: false,
      }),
    })

    const body = (await (await ask()).json()) as { data: { sources: Array<{ slug: string }> } }
    // The model will cite slugs it made up. A citation nobody can open is worse than no citation.
    expect(body.data.sources.map((source) => source.slug)).toEqual([article.data.slug])
  })

  it('answers rather than failing when the model returns something outside the schema', async () => {
    const article = await publishArticle()
    stubVectorize({
      query: vi.fn(async () => ({
        matches: [{ id: `${article.data.id}:en:0`, score: 0.8, metadata: { article_id: article.data.id } }],
      })),
    })
    stubAiWith({ response: 'not json at all' })

    const response = await ask()
    expect(response.status).toBe(200)
    expect(((await response.json()) as { data: { answer: null } }).data.answer).toBeNull()
  })

  it('meters every call, so a runaway loop shows up before the invoice does', async () => {
    const article = await publishArticle()
    stubVectorize({
      query: vi.fn(async () => ({
        matches: [{ id: `${article.data.id}:en:0`, score: 0.8, metadata: { article_id: article.data.id } }],
      })),
    })
    stubAiWith({
      response: JSON.stringify({ answer: 'x', cited_slugs: [], confidence: 'low', insufficient_context: false }),
    })

    await ask()

    // Scoped to this agent: publishing an article also embeds, and those rows carry no actor.
    const rows = await allRows<{ kind: string }>(
      "SELECT kind FROM ai_requests WHERE actor_email = 'fran@franciscosolis.cl' ORDER BY kind",
    )
    // Both halves are metered, because both are billed: Workers AI has no per-Worker spend cap.
    expect(rows.map((row) => row.kind)).toEqual(['assist', 'embed'])
  })

  it('refuses an agent past the hourly ceiling', async () => {
    await publishArticle()
    // Seeded straight into the meter: the ceiling is the point, not sixty round trips to reach it.
    await env.DB.batch(
      Array.from({ length: ASSIST.hourlyLimitPerAgent }, (_unused, index) =>
        env.DB.prepare(
          "INSERT INTO ai_requests (id, kind, model, actor_email, ok) VALUES (?, 'assist', 'test', 'fran@franciscosolis.cl', 1)",
        ).bind(`seed-${index}`),
      ),
    )

    const response = await ask()
    expect(response.status).toBe(429)
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0)
  })

  it('is closed to an agent without the administrator permission', async () => {
    const response = await call('/admin/assist', {
      method: 'POST',
      headers: await asAgent({ permissions: ['support:agent'] }),
      body: JSON.stringify({ query: 'anything at all' }),
    })
    expect(response.status).toBe(403)
  })

  it('refuses a query too short to mean anything', async () => {
    expect((await ask('a')).status).toBe(400)
  })
})
