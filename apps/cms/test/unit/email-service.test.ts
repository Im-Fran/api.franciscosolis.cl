import { env } from 'cloudflare:test'
import { HTTPException } from 'hono/http-exception'
import { beforeEach, describe, expect, it } from 'vitest'
import type { EmailMessage, EmailSender, Env } from '@/env'
import { renderTemplate, resolveSender, sendEmail, toPublicMessage } from '@/services/email'
import { clearDatabase, db } from '../helpers/db'

/** An `EMAIL` binding that records what it was handed instead of talking to Cloudflare. */
const recordingSender = (result: { messageId: string } | Error) => {
  const sent: EmailMessage[] = []
  const sender: EmailSender = {
    send: async (message) => {
      sent.push(message)
      if (result instanceof Error) {
        throw result
      }
      return result
    },
  }
  return { sender, sent }
}

const envWith = (overrides: Partial<Env>) => ({ ...env, ...overrides }) as Env

const readMessageRow = async (id: string) =>
  env.DB.prepare('SELECT status, message_id, error, sent_at, to_addresses, from_email, template_slug, sent_by FROM email_messages WHERE id = ?')
    .bind(id)
    .first<{
      status: string
      message_id: string | null
      error: string | null
      sent_at: number | null
      to_addresses: string
      from_email: string
      template_slug: string | null
      sent_by: string
    }>()

beforeEach(clearDatabase)

describe('resolveSender', () => {
  it('defaults to MAIL_FROM_EMAIL with its display name', () => {
    expect(resolveSender(env as Env)).toEqual({
      email: 'hola@mail.franciscosolis.cl',
      name: 'Francisco Solis',
    })
  })

  it('treats null and an empty string as "no preference"', () => {
    expect(resolveSender(env as Env, null).email).toBe('hola@mail.franciscosolis.cl')
    expect(resolveSender(env as Env, '').email).toBe('hola@mail.franciscosolis.cl')
  })

  it('accepts an address on the allowlist', () => {
    expect(resolveSender(env as Env, 'no-reply@mail.franciscosolis.cl')).toEqual({
      email: 'no-reply@mail.franciscosolis.cl',
      name: 'Francisco Solis',
    })
  })

  it('normalises case and padding before comparing', () => {
    expect(resolveSender(env as Env, '  NO-REPLY@Mail.FranciscoSolis.CL  ').email).toBe(
      'no-reply@mail.franciscosolis.cl',
    )
  })

  it('refuses an address that is not on the allowlist', () => {
    // The first of two stacked allowlists; Cloudflare's own `allowed_sender_addresses` is the
    // outer bound, but this one is what turns a bad request into a 400 instead of a 500.
    expect(() => resolveSender(env as Env, 'evil@elsewhere.com')).toThrow(HTTPException)
    try {
      resolveSender(env as Env, 'evil@elsewhere.com')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as HTTPException).status).toBe(400)
      expect((error as HTTPException).message).toContain('Sender evil@elsewhere.com is not allowed')
      expect((error as HTTPException).message).toContain('hola@mail.franciscosolis.cl')
    }
  })

  it('refuses a lookalike of an allowed address', () => {
    expect(() => resolveSender(env as Env, 'hola@mail.franciscosolis.cl.evil.com')).toThrow(HTTPException)
    expect(() => resolveSender(env as Env, 'hola@franciscosolis.cl')).toThrow(HTTPException)
  })

  it('refuses everything explicit when the allowlist is empty', () => {
    expect(() => resolveSender(envWith({ MAIL_ALLOWED_SENDERS: '' }), 'hola@mail.franciscosolis.cl')).toThrow(
      HTTPException,
    )
  })

  it('still falls back to the default sender when the allowlist is empty', () => {
    // Only an explicit `from` is checked; the configured default is trusted by construction.
    expect(resolveSender(envWith({ MAIL_ALLOWED_SENDERS: '' })).email).toBe('hola@mail.franciscosolis.cl')
  })
})

describe('renderTemplate', () => {
  const template = { subject: 'Hola {{ name }}', html: '<p>{{ name }} — {{ city }}</p>', text: '{{ name }}' }

  it('fills every placeholder in subject, html and text', () => {
    expect(renderTemplate(template, { name: 'Fran', city: 'Santiago' })).toEqual({
      subject: 'Hola Fran',
      html: '<p>Fran — Santiago</p>',
      text: 'Fran',
    })
  })

  it('refuses a send that is missing a variable', () => {
    // Mailing "Hola ," to a real person is worse than refusing the request.
    expect(() => renderTemplate(template, { name: 'Fran' })).toThrow(HTTPException)
  })

  it('names every missing variable once, across all three fields', () => {
    try {
      renderTemplate(template, {})
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as HTTPException).status).toBe(400)
      expect((error as HTTPException).message).toBe('Missing values for template variables: name, city')
    }
  })

  it('keeps a null body null instead of rendering it as an empty string', () => {
    expect(renderTemplate({ subject: 'Hi {{ a }}', html: null, text: null }, { a: '1' })).toEqual({
      subject: 'Hi 1',
      html: null,
      text: null,
    })
  })

  it('does not demand values for placeholders in a body that is null', () => {
    expect(() => renderTemplate({ subject: 'Fixed', html: null, text: null }, {})).not.toThrow()
  })

  it('accepts an empty string as a value', () => {
    expect(renderTemplate({ subject: 'Hola {{ name }}', html: null, text: null }, { name: '' })).toEqual({
      subject: 'Hola ',
      html: null,
      text: null,
    })
  })

  it('ignores values with no matching placeholder', () => {
    expect(
      renderTemplate({ subject: 'Fixed', html: null, text: null }, { unused: 'x' }).subject,
    ).toBe('Fixed')
  })

  it('inserts the value verbatim, markup and all', () => {
    expect(
      renderTemplate({ subject: 'S', html: '<p>{{ body }}</p>', text: null }, { body: '<a href="#">link</a>' }).html,
    ).toBe('<p><a href="#">link</a></p>')
  })
})

describe('sendEmail', () => {
  const input = {
    to: ['someone@example.com'],
    from: { email: 'hola@mail.franciscosolis.cl', name: 'Francisco Solis' },
    subject: 'Subject',
    html: '<p>Body</p>',
    text: 'Body',
    replyTo: 'reply@franciscosolis.cl',
    templateSlug: null,
    sentBy: 'fran@franciscosolis.cl',
  }

  it('hands the message to the binding and records it as sent', async () => {
    const { sender, sent } = recordingSender({ messageId: '<abc@mail>' })
    const message = await sendEmail(db(), envWith({ EMAIL: sender }), input)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({
      from: input.from,
      to: ['someone@example.com'],
      subject: 'Subject',
      html: '<p>Body</p>',
      text: 'Body',
      replyTo: 'reply@franciscosolis.cl',
    })
    expect(message.status).toBe('sent')
    expect(message.messageId).toBe('<abc@mail>')
    expect(message.sentAt).toBeInstanceOf(Date)
  })

  it('persists the outcome on the row it wrote up front', async () => {
    const { sender } = recordingSender({ messageId: '<abc@mail>' })
    const message = await sendEmail(db(), envWith({ EMAIL: sender }), input)

    const row = await readMessageRow(message.id)
    expect(row?.status).toBe('sent')
    expect(row?.message_id).toBe('<abc@mail>')
    expect(row?.sent_at).toEqual(expect.any(Number))
    expect(JSON.parse(row?.to_addresses ?? '[]')).toEqual(['someone@example.com'])
    expect(row?.sent_by).toBe('fran@franciscosolis.cl')
  })

  it('leaves a trace when the provider fails, rather than losing the attempt', async () => {
    const { sender } = recordingSender(new Error('provider unavailable'))
    const message = await sendEmail(db(), envWith({ EMAIL: sender }), input)

    expect(message.status).toBe('failed')
    expect(message.error).toBe('provider unavailable')
    expect(message.messageId).toBeNull()
    expect(message.sentAt).toBeNull()

    const row = await readMessageRow(message.id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toBe('provider unavailable')
    expect(row?.message_id).toBeNull()
  })

  it('does not throw on a provider failure — the caller answers 202 either way', async () => {
    const { sender } = recordingSender(new Error('boom'))

    await expect(sendEmail(db(), envWith({ EMAIL: sender }), input)).resolves.toMatchObject({ status: 'failed' })
  })

  it('records a nameless provider error rather than an empty string', async () => {
    const sender: EmailSender = {
      send: async () => {
        throw new Error('')
      },
    }
    const message = await sendEmail(db(), envWith({ EMAIL: sender }), input)

    expect(message.error).toBe('Unknown error')
  })

  it('omits an absent body or reply-to from what the binding is handed', async () => {
    const { sender, sent } = recordingSender({ messageId: '<id>' })
    await sendEmail(db(), envWith({ EMAIL: sender }), { ...input, html: null, replyTo: null })

    expect(sent[0]).not.toHaveProperty('html')
    expect(sent[0]).not.toHaveProperty('replyTo')
    expect(sent[0]?.text).toBe('Body')
  })

  it('writes the row before the send is attempted', async () => {
    // The row has to exist even if the isolate dies mid-flight, so the insert cannot wait for the
    // provider to answer.
    let rowsDuringSend = 0
    const sender: EmailSender = {
      send: async () => {
        const row = await env.DB.prepare('SELECT count(*) AS total FROM email_messages').first<{ total: number }>()
        rowsDuringSend = row?.total ?? 0
        return { messageId: '<id>' }
      },
    }

    await sendEmail(db(), envWith({ EMAIL: sender }), input)
    expect(rowsDuringSend).toBe(1)
  })

  it('keeps the template slug on the logged row', async () => {
    const { sender } = recordingSender({ messageId: '<id>' })
    const message = await sendEmail(db(), envWith({ EMAIL: sender }), { ...input, templateSlug: 'welcome' })

    expect((await readMessageRow(message.id))?.template_slug).toBe('welcome')
  })

  it('gives every message its own id', async () => {
    const { sender } = recordingSender({ messageId: '<id>' })
    const first = await sendEmail(db(), envWith({ EMAIL: sender }), input)
    const second = await sendEmail(db(), envWith({ EMAIL: sender }), input)

    expect(first.id).not.toBe(second.id)
  })

  it('passes every recipient through', async () => {
    const { sender, sent } = recordingSender({ messageId: '<id>' })
    const recipients = ['a@example.com', 'b@example.com', 'c@example.com']
    const message = await sendEmail(db(), envWith({ EMAIL: sender }), { ...input, to: recipients })

    expect(sent[0]?.to).toEqual(recipients)
    expect(JSON.parse((await readMessageRow(message.id))?.to_addresses ?? '[]')).toEqual(recipients)
  })
})

describe('toPublicMessage', () => {
  it('renders the logged message, bodies included', async () => {
    const { sender } = recordingSender({ messageId: '<abc@mail>' })
    const message = await sendEmail(db(), envWith({ EMAIL: sender }), {
      to: ['a@example.com', 'b@example.com'],
      from: { email: 'hola@mail.franciscosolis.cl', name: 'Francisco Solis' },
      subject: 'Subject',
      html: '<p>Body</p>',
      text: 'Body',
      replyTo: null,
      templateSlug: 'welcome',
      sentBy: 'fran@franciscosolis.cl',
    })

    expect(toPublicMessage(message)).toEqual({
      id: message.id,
      to: ['a@example.com', 'b@example.com'],
      from_email: 'hola@mail.franciscosolis.cl',
      from_name: 'Francisco Solis',
      reply_to: null,
      subject: 'Subject',
      html: '<p>Body</p>',
      text: 'Body',
      template_slug: 'welcome',
      status: 'sent',
      message_id: '<abc@mail>',
      error: null,
      sent_by: 'fran@franciscosolis.cl',
      sent_at: expect.any(String),
      created_at: expect.any(String),
    })
  })

  it('reports a failed send with its error and no sent_at', async () => {
    const { sender } = recordingSender(new Error('nope'))
    const message = await sendEmail(db(), envWith({ EMAIL: sender }), {
      to: ['a@example.com'],
      from: { email: 'hola@mail.franciscosolis.cl' },
      subject: 'S',
      html: null,
      text: 'T',
      replyTo: null,
      templateSlug: null,
      sentBy: 'fran@franciscosolis.cl',
    })

    const shape = toPublicMessage(message)
    expect(shape.status).toBe('failed')
    expect(shape.error).toBe('nope')
    expect(shape.sent_at).toBeNull()
    expect(shape.message_id).toBeNull()
    expect(shape.from_name).toBeNull()
  })
})

describe('the real EMAIL binding under miniflare', () => {
  // Miniflare implements Cloudflare Email Sending for real, `allowed_sender_addresses` included,
  // so the happy path can be exercised against the actual binding rather than a stub. Its refusal
  // path cannot: the binding is an RPC target and a rejected send also surfaces as an unhandled
  // rejection, which fails the whole run. `resolveSender` covers that boundary above instead.
  it('accepts an allowlisted sender and answers with a message id', async () => {
    const result = await env.EMAIL.send({
      from: { email: 'no-reply@mail.franciscosolis.cl' },
      to: ['a@example.com'],
      subject: 'S',
      text: 'T',
    })

    expect(result.messageId).toEqual(expect.any(String))
  })

  it('is the binding `sendEmail` writes a `sent` row from', async () => {
    const message = await sendEmail(db(), env as Env, {
      to: ['a@example.com'],
      from: { email: 'hola@mail.franciscosolis.cl', name: 'Francisco Solis' },
      subject: 'Real binding',
      html: null,
      text: 'Body',
      replyTo: null,
      templateSlug: null,
      sentBy: 'fran@franciscosolis.cl',
    })

    expect(message.status).toBe('sent')
    expect((await readMessageRow(message.id))?.status).toBe('sent')
  })
})
