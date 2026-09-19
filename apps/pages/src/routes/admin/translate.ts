import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { AppEnv } from '@/env'
import { TRANSLATABLE_FIELD_LIMITS, TRANSLATION } from '@/lib/config'
import { DEFAULT_LOCALE, LOCALES, TRANSLATION_LOCALES } from '@/lib/locales'
import { retryAfterSeconds, translateField, translationsByEditor } from '@/services/ai'

/**
 * `POST /admin/translate` — a first draft of one prose field in one other language.
 *
 * What it deliberately is *not*: a route that writes anything. It answers with a string and the
 * editor saves it, edits it, or throws it away through the ordinary PATCH that saves every other
 * override. Three things follow from that, and all three are the point:
 *
 * - A model outage cannot corrupt a record, because nothing here touches a single table.
 * - A machine translation is never published without somebody having seen it, because publishing
 *   is a separate request a human makes.
 * - There is no "translated by AI" flag to keep in sync, because by the time the text is stored it
 *   is simply what the editor wrote.
 *
 * The field is translated one at a time rather than a whole record at once. That is what the
 * front-end's per-field modal asks for, and it is also the cheaper failure: a record-wide call that
 * half-succeeds has to be explained, while a field-sized one either produced a draft or did not.
 *
 * It takes the field's *name* and nothing else about the row, so one route serves an application
 * page, a release note and a wiki page. The three have different field sets and the same three
 * kinds of prose — a name, a heading, a body — which is all the prompt is shaped by.
 */
const app = new Hono<AppEnv>()

const bodySchema = v.object({
  /** The source text, in `source_locale`. Empty or over the cap is a 422 rather than a null answer. */
  text: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(TRANSLATION.maxSourceChars)),
  /** Names the field so a heading comes back a heading, and picks the cap the answer is held to. */
  field: v.picklist(Object.keys(TRANSLATABLE_FIELD_LIMITS) as [string, ...string[]]),
  /** Defaults to the locale the row itself holds, which is where a translation is always written from. */
  source_locale: v.optional(v.picklist(LOCALES)),
  /** A locale the row can carry an override for. The default locale is not one of them. */
  target_locale: v.picklist(TRANSLATION_LOCALES),
})

const responseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    /** The draft, or `null` when no usable answer came back. Never an error — see below. */
    translation: v.nullable(v.string()),
    field: v.string(),
    source_locale: v.string(),
    target_locale: v.string(),
    model: v.string(),
  }),
})

app.post(
  '/translate',
  describeRoute({
    description:
      'Drafts a translation of one prose field into one other language with Workers AI. It writes nothing: the draft is returned for an editor to review, edit and save through the ordinary PATCH. A failed or unusable model answer comes back as `translation: null` with a 200 — the draft is an offer, not a step in saving a record.',
    tags: ['Admin · Translate'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The draft, or a null translation when none could be produced',
        content: { 'application/json': { schema: resolver(responseSchema) } },
      },
      401: { description: 'Missing or invalid access token' },
      403: { description: 'Account not allowed to edit these pages' },
      422: { description: 'The body failed validation' },
      429: { description: 'Too many translation requests from this editor in the last hour' },
    },
  }),
  validator('json', bodySchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()

    const sourceLocale = body.source_locale ?? DEFAULT_LOCALE
    if (sourceLocale === body.target_locale) {
      throw new HTTPException(422, { message: 'The source and target locales must differ' })
    }

    // Workers AI is billed per neuron with no per-Worker spend cap, so a loop in the front-end is a
    // bill rather than an outage. This is the cheap ceiling on that.
    if ((await translationsByEditor(db, editor.email, now)) >= TRANSLATION.hourlyLimitPerEditor) {
      c.header('Retry-After', String(retryAfterSeconds(now)))
      throw new HTTPException(429, { message: 'Too many translation requests in the last hour' })
    }

    const translation = await translateField(db, c.env, {
      text: body.text,
      field: body.field,
      sourceLocale,
      targetLocale: body.target_locale,
      maxLength: TRANSLATABLE_FIELD_LIMITS[body.field as keyof typeof TRANSLATABLE_FIELD_LIMITS],
      actorEmail: editor.email,
    })

    return c.json({
      code: 200,
      data: {
        translation,
        field: body.field,
        source_locale: sourceLocale,
        target_locale: body.target_locale,
        model: c.env.AI_TEXT_MODEL,
      },
    })
  },
)

export default app
