import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { AppEnv } from '@/env'
import { ADMIN_PERMISSION, ASSIST } from '@/lib/config'
import { DEFAULT_LOCALE, LOCALES, ARTICLE_TRANSLATABLE_FIELDS, localize, parseTranslations, resolveLocale } from '@/lib/locales'
import type { Locale } from '@/lib/locales'
import { requirePermission } from '@/middleware/auth'
import { embed, runModel } from '@/services/ai'
import { getActorContext, getRequestContext, recordAudit } from '@/services/audit'
import { findArticlesByIds } from '@/services/help'
import { assistCallsByAgent, retryAfterSeconds } from '@/services/rate-limit'

const app = new Hono<AppEnv>()

const bodySchema = v.object({
  query: v.pipe(v.string(), v.trim(), v.minLength(3), v.maxLength(ASSIST.maxQueryLength)),
  locale: v.optional(v.picklist(LOCALES)),
  ticket_id: v.optional(v.string()),
})

const responseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    answer: v.nullable(v.string()),
    insufficient_context: v.boolean(),
    confidence: v.nullable(v.string()),
    sources: v.array(v.looseObject({ slug: v.string(), title: v.string() })),
    model: v.string(),
  }),
})

const ANSWER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    cited_slugs: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    insufficient_context: { type: 'boolean' },
  },
  required: ['answer', 'cited_slugs', 'confidence', 'insufficient_context'],
} as const

const answerSchema = v.object({
  answer: v.pipe(v.string(), v.maxLength(4000)),
  cited_slugs: v.array(v.string()),
  confidence: v.picklist(['high', 'medium', 'low']),
  insufficient_context: v.boolean(),
})

app.post(
  '/assist',
  describeRoute({
    description:
      'Drafts an answer to a question using the published help centre as its only source. The draft lands in the composer for an agent to edit; it is never sent on its own.',
    tags: ['Admin · Assist'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'A draft, with the articles it came from', content: { 'application/json': { schema: resolver(responseSchema) } } },
      403: { description: 'Missing the support:admin permission' },
      429: { description: 'Too many assistant calls from this agent in the last hour' },
      400: { description: 'The body failed validation' },
    },
  }),
  requirePermission(ADMIN_PERMISSION),
  validator('json', bodySchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const agent = c.get('agent')
    const locale: Locale = body.locale ?? DEFAULT_LOCALE
    const now = new Date()

    // Workers AI is billed per neuron with no per-Worker cap, so a loop in a front-end is a bill
    // rather than an outage. This is the cheap ceiling on that.
    if ((await assistCallsByAgent(db, agent.email, now)) >= ASSIST.hourlyLimitPerAgent) {
      c.header('Retry-After', String(retryAfterSeconds(now)))
      throw new HTTPException(429, { message: 'Too many assistant requests in the last hour' })
    }

    const empty = (reason: string) =>
      c.json({
        code: 200,
        data: {
          answer: null,
          insufficient_context: true,
          confidence: null,
          sources: [],
          model: c.env.AI_TEXT_MODEL,
          reason,
        },
      })

    const vector = await embed(db, c.env, body.query, agent.email)
    if (!vector) {
      return empty('the question could not be embedded')
    }

    const matches = await c.env.VECTORIZE.query(vector, {
      topK: ASSIST.topK,
      returnMetadata: 'indexed',
      filter: { locale },
    })

    const scored = (matches.matches ?? []).filter((match) => match.score >= ASSIST.minScore)
    const articleIds = [
      ...new Set(scored.map((match) => String(match.metadata?.article_id ?? '')).filter(Boolean)),
    ]

    // Always re-read from D1 rather than trusting the vector's metadata. Vectorize and D1 cannot be
    // transactional with each other, so this is what stops an orphaned vector from an unpublished
    // draft ever reaching the prompt — and it is why there is no reconciliation job.
    const articles = (await findArticlesByIds(db, articleIds)).filter((article) => article.status === 'published')

    if (articles.length === 0) {
      // The cheapest and most honest guard there is: no sources, no model call, no invented answer.
      return empty('no published article matched the question')
    }

    const sources = articles.map((article) => {
      const translations = parseTranslations(article.translations)
      const resolved = resolveLocale(translations, locale)
      const localized = localize(
        { title: article.title, summary: article.summary, body: article.body },
        translations,
        resolved,
        ARTICLE_TRANSLATABLE_FIELDS,
      )
      const score = scored.find((match) => match.metadata?.article_id === article.id)?.score ?? 0
      return {
        slug: article.slug,
        title: localized.title,
        locale: resolved,
        score,
        text: [localized.summary, localized.body].filter(Boolean).join('\n\n').slice(0, ASSIST.maxChunkChars),
      }
    })

    let budget = ASSIST.maxContextChars
    const context = sources
      .filter((source) => {
        budget -= source.text.length
        return budget > 0
      })
      .map((source, index) => `[${index + 1}] slug: ${source.slug}\ntitle: ${source.title}\n${source.text}`)
      .join('\n\n---\n\n')

    const output = await runModel(db, c.env, {
      kind: 'assist',
      model: c.env.AI_TEXT_MODEL,
      actorEmail: agent.email,
      ticketId: body.ticket_id ?? null,
      inputChars: context.length + body.query.length,
      timeoutMs: ASSIST.timeoutMs,
      input: {
        messages: [
          {
            role: 'system',
            content: [
              'You draft replies for the franciscosolis.cl support team.',
              'Answer ONLY from the numbered sources below. If they do not contain the answer, set',
              'insufficient_context to true and keep the answer short.',
              'Never invent a URL, a price, a date, a product name or a policy.',
              `Write the answer in ${locale === 'es' ? 'Spanish' : 'English'}.`,
              'Cite by slug, using only slugs that appear in the sources.',
              'Write as the support team ("we"), addressing the person directly. Do not greet or sign off.',
            ].join(' '),
          },
          { role: 'user', content: `Sources:\n\n${context}\n\nQuestion: ${body.query}` },
        ],
        response_format: { type: 'json_schema', json_schema: ANSWER_JSON_SCHEMA },
      },
    })

    if (!output) {
      return empty('the model did not answer')
    }

    const raw = (output as { response?: unknown }).response ?? output
    let candidate: unknown = raw
    if (typeof raw === 'string') {
      try {
        candidate = JSON.parse(raw)
      } catch {
        return empty('the model answered with something that was not JSON')
      }
    }

    const parsed = v.safeParse(answerSchema, candidate)
    if (!parsed.success) {
      return empty('the model answered with something outside the schema')
    }

    // The model *will* cite slugs it invented. Intersecting with what was actually retrieved is not
    // optional: a citation nobody can open is worse than no citation.
    const retrieved = new Set(sources.map((source) => source.slug))
    const cited = parsed.output.cited_slugs.filter((slug) => retrieved.has(slug))

    await recordAudit(db, {
      event: 'assist.requested',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'help_articles',
      resourceId: body.ticket_id ?? null,
      // The question, not the answer, and never the ticket body: this trail is read out in the
      // console.
      metadata: { sources: cited.length, confidence: parsed.output.confidence },
    })

    return c.json({
      code: 200,
      data: {
        answer: parsed.output.insufficient_context ? null : parsed.output.answer,
        insufficient_context: parsed.output.insufficient_context,
        confidence: parsed.output.confidence,
        sources: sources
          .filter((source) => cited.length === 0 || cited.includes(source.slug))
          .map(({ slug, title, locale: sourceLocale, score }) => ({ slug, title, locale: sourceLocale, score })),
        model: c.env.AI_TEXT_MODEL,
      },
    })
  },
)

export default app
