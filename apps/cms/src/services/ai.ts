import { and, count, eq, gte } from 'drizzle-orm'
import { formatForField, translate } from '@franciscosolis/translate'
import type { Database } from '@/db/client'
import { aiRequests } from '@/db/schema'
import type { Env } from '@/env'
import { TRANSLATION } from '@/lib/config'
import type { Locale } from '@/lib/locales'

/**
 * Every call this Worker makes to Workers AI, and the meter beside it.
 *
 * There is exactly one caller — `POST /admin/translate`, which drafts one prose field in one other
 * language — and it is never on the path that saves a record. A model outage, a timeout or an
 * answer that could not be read costs the editor a button that produced nothing, never a draft.
 * That is why nothing here throws: the failure modes are all the same failure to the person in
 * front of it.
 *
 * The prompt itself is not here. It lives in `@franciscosolis/translate`, shared with `apps/pages`
 * and `apps/support`, because the three Workers differ in the database the call is metered in and
 * the gate in front of it, not in a single word of what the model is asked.
 */

/** The only kind of AI request this Worker makes. A column rather than a constant, so a second one costs no migration. */
type AiKind = 'translate'

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

/**
 * Drafts one field in one language. `null` for every kind of failure, which the route turns into a
 * single honest message rather than an account of somebody else's outage.
 */
const translateField = async (
  db: Database,
  env: Env,
  input: {
    text: string
    field: string
    sourceLocale: Locale
    targetLocale: Locale
    maxLength?: number
    actorEmail: string
  },
): Promise<string | null> =>
  translate(
    (modelInput) =>
      runModel(db, env, {
        kind: 'translate',
        model: env.AI_TEXT_MODEL,
        input: modelInput,
        inputChars: input.text.length,
        actorEmail: input.actorEmail,
        timeoutMs: TRANSLATION.timeoutMs,
      }),
    {
      text: input.text,
      field: input.field,
      format: formatForField(input.field),
      sourceLocale: input.sourceLocale,
      targetLocale: input.targetLocale,
      maxLength: input.maxLength,
    },
  )

const hourAgo = (now: Date) => new Date(now.getTime() - 3600_000)

/**
 * Translations one editor has asked for in the last hour.
 *
 * Counted over `ai_requests` rather than a counter of its own, so a call that failed still counts:
 * a front-end stuck in a loop is billing neurons whether or not the answers came back, and that is
 * the thing being limited.
 */
const translationsByEditor = async (db: Database, email: string, now: Date): Promise<number> => {
  const [row] = await db
    .select({ total: count() })
    .from(aiRequests)
    .where(
      and(
        eq(aiRequests.kind, 'translate'),
        eq(aiRequests.actorEmail, email.toLowerCase()),
        gte(aiRequests.createdAt, hourAgo(now)),
      ),
    )
  return row?.total ?? 0
}

/** Seconds until the top of the next hour-window, for a `Retry-After` header. */
const retryAfterSeconds = (now: Date): number => 3600 - Math.floor((now.getTime() / 1000) % 3600)

export { retryAfterSeconds, runModel, translateField, translationsByEditor }
export type { AiKind }
