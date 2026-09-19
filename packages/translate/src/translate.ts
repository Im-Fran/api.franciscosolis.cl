import * as v from 'valibot'
import { languageName } from './languages'

/**
 * One machine translation, and the prompt behind it.
 *
 * Three Workers here store translations — the CMS, the standalone app pages and the support help
 * centre — and all three offer the same thing to an editor: a first draft of a field in another
 * language, produced by Workers AI, saved like any other override and edited afterwards. What
 * differs between them is the database the call is metered in and the gate in front of it, not a
 * single word of the prompt. So the prompt lives here, once.
 *
 * The package deliberately knows nothing about D1, Hono or `env`. It takes a `runner` — a function
 * that hands an input to a model and returns its output or `null` — and every Worker supplies its
 * own, wrapping its own meter. That is what keeps `ai_requests` the Worker's business and this
 * file's output a string.
 *
 * Everything here fails to `null` rather than throwing. A translation is an offer, never a step in
 * saving a record: a model outage has to cost the editor a button that did nothing, not a draft.
 */

/** What the caller is translating. */
type TranslationFormat = 'plain' | 'markdown'

type TranslateRequest = {
  /** The source text, in `sourceLocale`. */
  text: string
  sourceLocale: string
  targetLocale: string
  /**
   * The field's name (`title`, `summary`, `body`, …). It is in the prompt because the same
   * sentence is a heading in one field and a paragraph in another, and a title that comes back as
   * a sentence with a full stop is a translation an editor has to retype.
   */
  field?: string
  format: TranslationFormat
  /**
   * The API's own cap on the field. Named in the prompt *and* enforced on the answer — a model
   * asked to stay under 200 characters usually does, and "usually" is not a validator.
   */
  maxLength?: number
}

/** Hands an input to a model. Returns the raw output, or `null` when the call failed. */
type ModelRunner = (input: Record<string, unknown>) => Promise<unknown | null>

/** Constrains the grammar of the answer. It does not make the answer true — see `parseAnswer`. */
const TRANSLATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    translation: { type: 'string' },
  },
  required: ['translation'],
} as const

const answerSchema = v.object({
  translation: v.pipe(v.string(), v.maxLength(200_000)),
})

/**
 * The longest source text a single call will carry.
 *
 * Long-form bodies on this site run to 100 000 characters, which no chat model is going to
 * translate in one answer inside a Worker's time budget. Rather than silently truncating a
 * document, `translate` refuses above this and the front-end says so: a body that long is
 * translated in pieces by the person who wrote it.
 */
const MAX_SOURCE_CHARS = 8000

/**
 * Default bound on the model call. Bounds the response, not the spend — nothing can bound that.
 *
 * Deliberately below the front-end's own 20-second request timeout (`REQUEST_TIMEOUT_MS` in the
 * website repository's `src/lib/auth/client.ts`). A model call that outlives the browser's patience
 * is billed, answered and thrown away, and the editor is told nothing useful; abandoning it here
 * leaves time for the answer to travel and for the route to say honestly that no draft came back.
 */
const DEFAULT_TIMEOUT_MS = 15_000

/**
 * The system prompt.
 *
 * Written as rules rather than as a persona because every one of them is defending against a real
 * failure seen while building this: a model that answers the text instead of translating it, one
 * that "improves" a summary on the way through, one that translates the words inside a markdown
 * link target, and one that wraps its answer in a friendly sentence.
 */
const systemPrompt = (request: TranslateRequest): string => {
  const source = languageName(request.sourceLocale)
  const target = languageName(request.targetLocale)

  const rules = [
    `You are a translator for the website franciscosolis.cl. Translate from ${source} to ${target}.`,
    'Translate the text you are given. Never answer it, never summarise it, never add to it and never',
    'remove anything from it: the result must say exactly what the source says, in the other language.',
    'Keep the tone and the register of the source. Keep product names, brand names, people\'s names,',
    'code identifiers and URLs exactly as they are.',
  ]

  if (request.format === 'markdown') {
    rules.push(
      'The text is Markdown. Preserve its structure byte for byte: the same headings, lists, tables,',
      'block quotes, emphasis and code fences, in the same order. Translate link text but never a link',
      'target, and never translate anything inside a code fence or inline code span.',
    )
  } else {
    rules.push('Answer with plain text. Do not add Markdown formatting the source does not have.')
  }

  if (request.field === 'title' || request.field === 'subtitle') {
    rules.push('This is a heading. Keep it short and do not end it with a full stop unless the source does.')
  }

  if (request.maxLength) {
    rules.push(`The translation must be at most ${request.maxLength} characters long.`)
  }

  return rules.join(' ')
}

/**
 * Reads the model's answer back into a string.
 *
 * Workers AI returns `{ response: … }`, and `response` is a string for some models and an already
 * parsed object for others depending on whether JSON mode was honoured, so both shapes are
 * accepted. A model that ignored the schema entirely and answered in prose is treated as no
 * answer: half a translation offered as a whole one is worse than a button that did nothing.
 */
const parseAnswer = (output: unknown): string | null => {
  const raw = (output as { response?: unknown } | null)?.response ?? output
  const candidate = typeof raw === 'string' ? safeParse(raw) : raw

  const parsed = v.safeParse(answerSchema, candidate)
  if (!parsed.success) {
    return null
  }

  const translation = parsed.output.translation.trim()
  return translation.length > 0 ? translation : null
}

const safeParse = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/**
 * Translates one field.
 *
 * Returns `null` for every kind of failure there is — too long, model unreachable, timed out,
 * answered in a shape that could not be read, answered over the field's cap. The caller turns that
 * into one message: no translation was produced, try again. Distinguishing the causes for an editor
 * would be telling them about somebody else's outage.
 */
const translate = async (runner: ModelRunner, request: TranslateRequest): Promise<string | null> => {
  const text = request.text.trim()
  if (text.length === 0 || text.length > MAX_SOURCE_CHARS) {
    return null
  }
  if (request.sourceLocale === request.targetLocale) {
    return null
  }

  const output = await runner({
    messages: [
      { role: 'system', content: systemPrompt(request) },
      { role: 'user', content: text },
    ],
    response_format: { type: 'json_schema', json_schema: TRANSLATION_JSON_SCHEMA },
  })

  if (!output) {
    return null
  }

  const translation = parseAnswer(output)
  if (!translation) {
    return null
  }

  // The cap is a promise the API made to its own validator: a translation over it would be refused
  // on save, so offering it would hand the editor a draft they cannot keep.
  if (request.maxLength && translation.length > request.maxLength) {
    return null
  }

  return translation
}

export { DEFAULT_TIMEOUT_MS, MAX_SOURCE_CHARS, parseAnswer, systemPrompt, translate, TRANSLATION_JSON_SCHEMA }
export type { ModelRunner, TranslateRequest, TranslationFormat }
