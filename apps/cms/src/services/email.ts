import { renderContentEmail } from '@franciscosolis/emails'
import { eq } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import type { Database } from '@/db/client'
import { emailMessages } from '@/db/schema'
import type { EmailAddress, Env } from '@/env'
import { missingVariables, render } from '@/lib/template'

type EmailMessageRow = typeof emailMessages.$inferSelect

/**
 * Resolves the address a message goes out as.
 *
 * Two allowlists stack here. `MAIL_ALLOWED_SENDERS` is what an editor may pick, and
 * `allowed_sender_addresses` in wrangler.jsonc is what Cloudflare itself will accept — the second
 * one is the real boundary, so a mistake in the first can never turn into mail from an address
 * this Worker has no business using.
 */
const resolveSender = (env: Env, requested?: string | null): EmailAddress => {
  const allowed = env.MAIL_ALLOWED_SENDERS.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean)

  if (!requested) {
    return { email: env.MAIL_FROM_EMAIL, name: env.MAIL_FROM_NAME }
  }

  const candidate = requested.trim().toLowerCase()
  if (!allowed.includes(candidate)) {
    throw new HTTPException(400, {
      message: `Sender ${requested} is not allowed. Allowed senders: ${allowed.join(', ')}`,
    })
  }
  return { email: candidate, name: env.MAIL_FROM_NAME }
}

type RenderableTemplate = {
  subject: string
  html: string | null
  text: string | null
}

/**
 * Fills a template's placeholders in. Every `{{ variable }}` the template uses must have a value:
 * silently sending "Hi ," to a real person is worse than refusing the request.
 */
const renderTemplate = (template: RenderableTemplate, variables: Record<string, string>): RenderableTemplate => {
  const missing = [
    ...missingVariables(template.subject, variables),
    ...missingVariables(template.html ?? '', variables),
    ...missingVariables(template.text ?? '', variables),
  ]
  if (missing.length > 0) {
    throw new HTTPException(400, {
      message: `Missing values for template variables: ${[...new Set(missing)].join(', ')}`,
    })
  }

  return {
    subject: render(template.subject, variables),
    html: template.html === null ? null : render(template.html, variables),
    text: template.text === null ? null : render(template.text, variables),
  }
}

type LayoutInput = {
  subject: string
  /** Title inside the card. Defaults to the subject, which is what an editor usually means. */
  heading?: string | null
  html: string | null
  text: string | null
}

/**
 * Wraps an editorial body in the shared react-email shell, so a newsletter and a sign-in link from
 * `apps/auth` arrive looking like the same sender.
 *
 * Two deliberate limits. A message with no HTML part is left alone: promoting a plain-text send to
 * an HTML one is a change of intent, not of styling. And an editor-supplied `text` always wins —
 * the derived plain-text alternative only fills the gap for an HTML-only message, which used to go
 * out with no text part at all.
 *
 * The body is inserted verbatim rather than parsed; see `ContentEmail` for why that is safe here.
 */
const applyBrandedLayout = async (env: Env, input: LayoutInput): Promise<{ html: string | null, text: string | null }> => {
  if (!input.html) {
    return { html: input.html, text: input.text }
  }

  const branded = await renderContentEmail({
    subject: input.subject,
    heading: input.heading || input.subject,
    html: input.html,
    brandName: env.MAIL_FROM_NAME,
  })

  return { html: branded.html, text: input.text ?? branded.text }
}

type SendInput = {
  to: string[]
  from: EmailAddress
  subject: string
  html: string | null
  text: string | null
  replyTo: string | null
  templateSlug: string | null
  sentBy: string
}

/**
 * Hands a message to Cloudflare Email Sending and records it.
 *
 * The row is written before the send is attempted and updated with the outcome afterwards, so a
 * message that fails — or one whose isolate dies mid-flight — still leaves a trace. "What exactly
 * did we send that person, and did it go out" is the question `email_messages` exists to answer.
 */
const sendEmail = async (db: Database, env: Env, input: SendInput): Promise<EmailMessageRow> => {
  const id = crypto.randomUUID()
  const now = new Date()

  const base = {
    id,
    toAddresses: JSON.stringify(input.to),
    fromEmail: input.from.email,
    fromName: input.from.name ?? null,
    replyTo: input.replyTo,
    subject: input.subject,
    html: input.html,
    text: input.text,
    templateSlug: input.templateSlug,
    sentBy: input.sentBy,
    createdAt: now,
  }

  await db.insert(emailMessages).values({ ...base, status: 'queued' })

  try {
    const result = await env.EMAIL.send({
      from: input.from,
      to: input.to,
      subject: input.subject,
      ...(input.html ? { html: input.html } : {}),
      ...(input.text ? { text: input.text } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    })

    const sentAt = new Date()
    await db
      .update(emailMessages)
      .set({ status: 'sent', messageId: result.messageId, sentAt })
      .where(eq(emailMessages.id, id))

    return { ...base, status: 'sent', messageId: result.messageId, error: null, sentAt }
  } catch (error) {
    const message = (error as Error).message || 'Unknown error'
    await db.update(emailMessages).set({ status: 'failed', error: message }).where(eq(emailMessages.id, id))

    return { ...base, status: 'failed', messageId: null, error: message, sentAt: null }
  }
}

/** Public shape of a logged message. The rendered bodies are included: this is an editor-only view. */
const toPublicMessage = (message: EmailMessageRow) => ({
  id: message.id,
  to: JSON.parse(message.toAddresses) as string[],
  from_email: message.fromEmail,
  from_name: message.fromName,
  reply_to: message.replyTo,
  subject: message.subject,
  html: message.html,
  text: message.text,
  template_slug: message.templateSlug,
  status: message.status,
  message_id: message.messageId,
  error: message.error,
  sent_by: message.sentBy,
  sent_at: message.sentAt?.toISOString() ?? null,
  created_at: message.createdAt.toISOString(),
})

export { applyBrandedLayout, renderTemplate, resolveSender, sendEmail, toPublicMessage }
export type { EmailMessageRow, LayoutInput, RenderableTemplate, SendInput }
