import * as v from 'valibot'
import type { Database } from '@/db/client'
import { aiRequests } from '@/db/schema'
import type { Env } from '@/env'
import { INBOUND, TICKET_PRIORITY } from '@/lib/config'
import { LOCALES } from '@/lib/locales'

/**
 * Every call this Worker makes to Workers AI, and the meter beside it.
 *
 * `ai_requests` is not bookkeeping for its own sake: Workers AI is billed per neuron and there is no
 * per-Worker spend cap, so without a log the first sign of a runaway loop in a front-end is the
 * invoice. The same table is the rate limiter's index.
 *
 * Nothing here is on a critical path. Both callers treat a failure as "no answer", never as an
 * error — see `enrichTicket` below for why that matters more than a fallback branch would.
 */

type AiKind = 'assist' | 'email_extract' | 'embed'

/** Runs a model, records what it cost, and returns null rather than throwing. */
const runModel = async (
  db: Database,
  env: Env,
  options: {
    kind: AiKind
    model: string
    input: Record<string, unknown>
    inputChars: number
    actorEmail?: string | null
    ticketId?: string | null
    timeoutMs: number
  },
): Promise<unknown | null> => {
  const started = Date.now()
  let ok = true
  let error: string | null = null
  let output: unknown = null

  try {
    // `env.AI.run` takes no AbortSignal, so the race is the only bound available. It bounds the
    // *response*, not the spend — a model that keeps going after this is still billed.
    output = await Promise.race([
      env.AI.run(options.model, options.input),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error(`the model did not answer within ${options.timeoutMs}ms`)), options.timeoutMs),
      ),
    ])
  } catch (caught) {
    ok = false
    error = (caught as Error).message || 'unknown error'
  }

  try {
    await db.insert(aiRequests).values({
      id: crypto.randomUUID(),
      kind: options.kind,
      model: options.model,
      actorEmail: options.actorEmail ?? null,
      ticketId: options.ticketId ?? null,
      inputChars: options.inputChars,
      outputChars: ok ? JSON.stringify(output ?? '').length : 0,
      durationMs: Date.now() - started,
      ok,
      error,
    })
  } catch (logError) {
    // Losing the meter row must not lose the answer that was already paid for.
    console.error('failed to record an AI request', logError)
  }

  return ok ? output : null
}

/** What the extraction is allowed to tell us about an inbound email. */
const extractionSchema = v.object({
  subject: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  summary: v.pipe(v.string(), v.trim(), v.maxLength(400)),
  language: v.picklist(LOCALES),
  priority: v.picklist(TICKET_PRIORITY),
  contact_name: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(120)))),
})

type Extraction = v.InferOutput<typeof extractionSchema>

const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string', maxLength: 120 },
    summary: { type: 'string', maxLength: 400 },
    language: { type: 'string', enum: [...LOCALES] },
    priority: { type: 'string', enum: [...TICKET_PRIORITY] },
    contact_name: { type: 'string' },
  },
  required: ['subject', 'summary', 'language', 'priority'],
} as const

/**
 * Reads an inbound email and says what it is about.
 *
 * Deliberately **not** on the path that creates the ticket. The ticket is written first from the raw
 * headers, and this runs afterwards to improve it. That ordering is the whole design: a model
 * outage, a rate limit, a timeout or a malformed answer then costs a tidier subject line, never an
 * email. The alternative — extract, then create, with a fallback branch — puts the code that has to
 * work during an incident on the path that only runs during one, which is the code least likely to
 * have been exercised.
 *
 * `response_format: json_schema` constrains the grammar; it does not make the model's choices
 * trustworthy, so the result is parsed with valibot before anything is written.
 */
const extractFromEmail = async (
  db: Database,
  env: Env,
  input: { subject: string | null; body: string; from: string; ticketId: string },
): Promise<Extraction | null> => {
  const body = input.body.slice(0, INBOUND.aiInputChars)
  const prompt = [
    `From: ${input.from}`,
    `Subject: ${input.subject ?? '(none)'}`,
    '',
    body,
  ].join('\n')

  const output = await runModel(db, env, {
    kind: 'email_extract',
    model: env.AI_TEXT_MODEL,
    ticketId: input.ticketId,
    inputChars: prompt.length,
    timeoutMs: 15_000,
    input: {
      messages: [
        {
          role: 'system',
          content: [
            'You triage inbound support email for franciscosolis.cl.',
            'Summarise what the sender needs. Write the subject as a short description of the problem,',
            'not as a greeting. Use the language the sender wrote in.',
            'Only mark a request urgent when the sender says something is down or unusable for them;',
            'an exclamation mark is not urgency.',
          ].join(' '),
        },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_schema', json_schema: EXTRACTION_JSON_SCHEMA },
    },
  })

  if (!output) {
    return null
  }

  // Workers AI returns `{ response: … }`, and `response` is a string for some models and an object
  // for others depending on whether JSON mode was honoured. Both shapes are accepted; anything else
  // is treated as no answer.
  const raw = (output as { response?: unknown }).response ?? output
  const candidate = typeof raw === 'string' ? safeParse(raw) : raw

  const parsed = v.safeParse(extractionSchema, candidate)
  return parsed.success ? parsed.output : null
}

const safeParse = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** Embeds one piece of text. Returns null on any failure, like everything else here. */
const embed = async (
  db: Database,
  env: Env,
  text: string,
  actorEmail?: string | null,
): Promise<number[] | null> => {
  const output = await runModel(db, env, {
    kind: 'embed',
    model: env.AI_EMBEDDING_MODEL,
    inputChars: text.length,
    actorEmail,
    timeoutMs: 10_000,
    input: { text: [text] },
  })

  const vector = (output as { data?: number[][] } | null)?.data?.[0]
  return Array.isArray(vector) ? vector : null
}

export { embed, extractFromEmail, runModel }
export type { AiKind, Extraction }
