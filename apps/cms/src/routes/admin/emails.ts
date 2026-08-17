import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { emailMessages, emailTemplates } from '@/db/schema'
import type { AppEnv } from '@/env'
import { EMAIL_LIMITS, PAGINATION } from '@/lib/config'
import { getActorContext, getRequestContext, recordAudit } from '@/services/audit'
import { applyBrandedLayout, renderTemplate, resolveSender, sendEmail, toPublicMessage } from '@/services/email'

/**
 * Outgoing mail, sent through Cloudflare Email Sending from the `mail.franciscosolis.cl` domain.
 *
 * Sending is a privileged action with real-world reach, so it is bounded on every side: only an
 * authenticated CMS editor can call it, only allowlisted addresses can appear as the sender, the
 * recipient count is capped, and every attempt — successful or not — lands in `email_messages`.
 */
const app = new Hono<AppEnv>()

const recipient = v.pipe(v.string(), v.trim(), v.email(), v.maxLength(320))

const sendSchema = v.object({
  to: v.pipe(v.array(recipient), v.minLength(1), v.maxLength(EMAIL_LIMITS.maxRecipients)),
  /** Slug of a template to render. Without it, `subject` and a body are required inline. */
  template: v.optional(v.pipe(v.string(), v.trim(), v.toLowerCase())),
  /** Values for the template's `{{ placeholders }}`. Every placeholder must get one. */
  variables: v.optional(v.record(v.string(), v.string())),
  subject: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(EMAIL_LIMITS.maxSubjectLength))),
  html: v.optional(v.pipe(v.string(), v.maxLength(EMAIL_LIMITS.maxBodyLength))),
  text: v.optional(v.pipe(v.string(), v.maxLength(EMAIL_LIMITS.maxBodyLength))),
  /**
   * `branded` (the default) wraps the HTML body in the shared react-email shell. `raw` sends the
   * body exactly as given — the escape hatch for a body that is already a complete document.
   */
  layout: v.optional(v.picklist(['branded', 'raw'])),
  /** Title inside the branded card. Defaults to the subject. Ignored when `layout` is `raw`. */
  heading: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(EMAIL_LIMITS.maxSubjectLength))),
  /** Sender address. Must be one of `MAIL_ALLOWED_SENDERS`; defaults to `MAIL_FROM_EMAIL`. */
  from: v.optional(v.pipe(v.string(), v.trim(), v.email())),
  reply_to: v.optional(v.pipe(v.string(), v.trim(), v.email())),
})

const messageSchema = v.looseObject({ id: v.string(), subject: v.string(), status: v.string() })
const sendResponseSchema = v.object({ code: v.literal(202), data: messageSchema })

app.post(
  '/emails',
  describeRoute({
    description:
      'Sends an email, either from a stored template (`template` + `variables`) or from an inline body. A `subject` sent alongside a template overrides the template\'s own. The HTML body is wrapped in the shared house layout unless `layout` is `raw`, and an HTML-only message gets a plain-text alternative derived from it. The response carries the logged message, whose `status` is `sent` or `failed` — a provider failure is reported in the body rather than as an HTTP error, because the attempt was recorded either way.',
    tags: ['Admin · Email'],
    security: [{ bearerAuth: [] }],
    responses: {
      202: {
        description: 'The message was handed to Cloudflare Email Sending',
        content: { 'application/json': { schema: resolver(sendResponseSchema) } },
      },
      400: { description: 'The sender is not allowed, or template variables are missing' },
      401: { description: 'Missing or invalid access token' },
      403: { description: 'Account not allowed into the CMS' },
      404: { description: 'No such template' },
      422: { description: 'The message has no body, or no subject' },
    },
  }),
  validator('json', sendSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')

    let subject = body.subject ?? null
    let html = body.html ?? null
    let text = body.text ?? null
    let templateSlug: string | null = null

    if (body.template) {
      const [template] = await db
        .select()
        .from(emailTemplates)
        .where(eq(emailTemplates.slug, body.template))
        .limit(1)
      if (!template) {
        throw new HTTPException(404, { message: `No template with slug "${body.template}"` })
      }

      const rendered = renderTemplate(template, body.variables ?? {})
      templateSlug = template.slug
      // Inline fields win over the template's, so a one-off subject tweak does not need a new
      // template — but a body sent inline replaces the rendered one entirely, never merges.
      subject = body.subject ?? rendered.subject
      html = body.html ?? rendered.html
      text = body.text ?? rendered.text
    }

    if (!subject) {
      throw new HTTPException(422, { message: 'A subject is required' })
    }
    if (!html && !text) {
      throw new HTTPException(422, { message: 'A message needs at least one of `html` or `text`' })
    }

    if ((body.layout ?? 'branded') === 'branded') {
      ;({ html, text } = await applyBrandedLayout(c.env, { subject, heading: body.heading, html, text }))
    }

    const from = resolveSender(c.env, body.from)
    const message = await sendEmail(db, c.env, {
      to: body.to,
      from,
      subject,
      html,
      text,
      replyTo: body.reply_to ?? null,
      templateSlug,
      sentBy: editor.email,
    })

    await recordAudit(db, {
      event: message.status === 'sent' ? 'email.sent' : 'email.failed',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'email_messages',
      resourceId: message.id,
      // Recipients are recorded on the message row itself; the trail only needs the shape.
      metadata: { recipients: body.to.length, template: templateSlug, status: message.status },
    })

    return c.json({ code: 202, data: toPublicMessage(message) }, 202)
  },
)

const listQuerySchema = v.object({
  status: v.optional(v.picklist(['queued', 'sent', 'failed'])),
  limit: v.optional(
    v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(PAGINATION.maxLimit)),
  ),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
})

const listResponseSchema = v.object({ code: v.literal(200), data: v.array(messageSchema) })

app.get(
  '/emails',
  describeRoute({
    description: 'Log of every message this CMS has attempted to send, newest first.',
    tags: ['Admin · Email'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Sent messages', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
    },
  }),
  validator('query', listQuerySchema),
  async (c) => {
    const { status, limit = PAGINATION.defaultLimit, offset = 0 } = c.req.valid('query')

    const rows = await getDb(c.env)
      .select()
      .from(emailMessages)
      .where(status ? eq(emailMessages.status, status) : undefined)
      .orderBy(desc(emailMessages.createdAt))
      .limit(limit)
      .offset(offset)

    return c.json({ code: 200, data: rows.map(toPublicMessage) })
  },
)

app.get(
  '/emails/:id',
  describeRoute({
    description: 'A single logged message, including the body exactly as it was sent.',
    tags: ['Admin · Email'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The message', content: { 'application/json': { schema: resolver(sendResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such message' },
    },
  }),
  async (c) => {
    const [message] = await getDb(c.env)
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.id, c.req.param('id')))
      .limit(1)
    if (!message) {
      throw new HTTPException(404, { message: 'Message not found' })
    }

    return c.json({ code: 200, data: toPublicMessage(message) })
  },
)

export default app
