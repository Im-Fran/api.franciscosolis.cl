import { SELF, env } from 'cloudflare:test'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { EMAIL_LIMITS } from '@/lib/config'
import type { EmailMessage, EmailSender } from '@/env'
import { clearDatabase, countRows, readAuditLog, seedMessage, seedTemplate } from '../helpers/db'
import { asEditor } from '../helpers/tokens'

type LoggedMessage = {
  id: string
  to: string[]
  from_email: string
  from_name: string | null
  reply_to: string | null
  subject: string
  html: string | null
  text: string | null
  template_slug: string | null
  status: string
  message_id: string | null
  error: string | null
  sent_by: string
}

let headers: Record<string, string>
let realEmail: EmailSender
let sent: EmailMessage[]
let nextResult: { messageId: string } | Error

const call = (method: string, path: string, body?: unknown) =>
  SELF.fetch(`https://cms.internal${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const dataOf = async <T>(response: Response) => (await response.json<{ data: T }>()).data
const errorOf = async (response: Response) => (await response.json<{ error: string }>()).error

const rawRow = (id: string) =>
  env.DB.prepare('SELECT status, message_id, error, to_addresses, from_email, subject, html, text, template_slug, sent_by FROM email_messages WHERE id = ?')
    .bind(id)
    .first<{
      status: string
      message_id: string | null
      error: string | null
      to_addresses: string
      from_email: string
      subject: string
      html: string | null
      text: string | null
      template_slug: string | null
      sent_by: string
    }>()

beforeAll(async () => {
  headers = await asEditor()
  realEmail = env.EMAIL
})

afterAll(() => {
  env.EMAIL = realEmail
})

beforeEach(async () => {
  await clearDatabase()
  sent = []
  nextResult = { messageId: '<queued@mail.franciscosolis.cl>' }
  // Swapped for a recorder so a test can assert on what the binding was handed, and drive the
  // provider-failure path that the real one cannot be made to take.
  env.EMAIL = {
    send: async (message) => {
      sent.push(message)
      if (nextResult instanceof Error) {
        throw nextResult
      }
      return nextResult
    },
  }
})

describe('POST /admin/emails — inline message', () => {
  it('sends and answers 202 with the logged message', async () => {
    const response = await call('POST', '/admin/emails', {
      to: ['someone@example.com'],
      subject: 'Hola',
      text: 'Body',
    })
    const message = await dataOf<LoggedMessage>(response)

    expect(response.status).toBe(202)
    expect(message).toMatchObject({
      to: ['someone@example.com'],
      from_email: 'hola@mail.franciscosolis.cl',
      from_name: 'Francisco Solis',
      subject: 'Hola',
      text: 'Body',
      template_slug: null,
      status: 'sent',
      message_id: '<queued@mail.franciscosolis.cl>',
      error: null,
      sent_by: 'fran@franciscosolis.cl',
    })
  })

  it('hands the binding exactly what it was told to send', async () => {
    await call('POST', '/admin/emails', {
      to: ['a@example.com', 'b@example.com'],
      subject: 'Hola',
      html: '<p>Body</p>',
      reply_to: 'fran@franciscosolis.cl',
      // `raw` is the only mode where the body reaches the binding untouched; the default wraps it
      // in the house layout and derives a plain-text part from the result.
      layout: 'raw',
    })

    expect(sent).toEqual([
      {
        from: { email: 'hola@mail.franciscosolis.cl', name: 'Francisco Solis' },
        to: ['a@example.com', 'b@example.com'],
        subject: 'Hola',
        html: '<p>Body</p>',
        replyTo: 'fran@franciscosolis.cl',
      },
    ])
  })

  it('logs the message before the send is attempted', async () => {
    const message = await dataOf<LoggedMessage>(
      await call('POST', '/admin/emails', { to: ['a@example.com'], subject: 'S', text: 'T' }),
    )

    expect(await rawRow(message.id)).toMatchObject({
      status: 'sent',
      subject: 'S',
      text: 'T',
      sent_by: 'fran@franciscosolis.cl',
    })
  })

  it('422s a message with no body', async () => {
    const response = await call('POST', '/admin/emails', { to: ['a@example.com'], subject: 'S' })

    expect(response.status).toBe(422)
    expect(await errorOf(response)).toBe('A message needs at least one of `html` or `text`')
    expect(await countRows('email_messages')).toBe(0)
  })

  it('422s a message with no subject', async () => {
    const response = await call('POST', '/admin/emails', { to: ['a@example.com'], text: 'T' })

    expect(response.status).toBe(422)
    expect(await errorOf(response)).toBe('A subject is required')
  })

  it('400s an empty or non-email recipient list', async () => {
    expect((await call('POST', '/admin/emails', { to: [], subject: 'S', text: 'T' })).status).toBe(400)
    expect((await call('POST', '/admin/emails', { to: ['not-an-email'], subject: 'S', text: 'T' })).status).toBe(400)
    expect((await call('POST', '/admin/emails', { subject: 'S', text: 'T' })).status).toBe(400)
  })
})

describe('POST /admin/emails — the ceilings in EMAIL_LIMITS', () => {
  it('accepts exactly maxRecipients and refuses one more', async () => {
    const recipients = (count: number) => Array.from({ length: count }, (_, index) => `user${index}@example.com`)

    expect(
      (await call('POST', '/admin/emails', { to: recipients(EMAIL_LIMITS.maxRecipients), subject: 'S', text: 'T' }))
        .status,
    ).toBe(202)
    expect(
      (await call('POST', '/admin/emails', { to: recipients(EMAIL_LIMITS.maxRecipients + 1), subject: 'S', text: 'T' }))
        .status,
    ).toBe(400)
  })

  it('accepts exactly maxSubjectLength and refuses one more', async () => {
    const atLimit = 'x'.repeat(EMAIL_LIMITS.maxSubjectLength)

    expect((await call('POST', '/admin/emails', { to: ['a@example.com'], subject: atLimit, text: 'T' })).status).toBe(202)
    expect(
      (await call('POST', '/admin/emails', { to: ['a@example.com'], subject: `${atLimit}x`, text: 'T' })).status,
    ).toBe(400)
  })

  it('refuses a body past maxBodyLength, html and text alike', async () => {
    const tooLong = 'x'.repeat(EMAIL_LIMITS.maxBodyLength + 1)

    expect((await call('POST', '/admin/emails', { to: ['a@example.com'], subject: 'S', text: tooLong })).status).toBe(400)
    expect((await call('POST', '/admin/emails', { to: ['a@example.com'], subject: 'S', html: tooLong })).status).toBe(400)
  })

  it('holds a single recipient to 320 characters', async () => {
    // The address has to stay syntactically valid to reach the length check at all — `v.email()`
    // runs first in the pipe, so a shapeless string would be refused for the wrong reason.
    const atLimit = `${'a'.repeat(308)}@example.com`
    const overLimit = `${'a'.repeat(309)}@example.com`

    expect(atLimit).toHaveLength(320)
    expect(overLimit).toHaveLength(321)
    expect((await call('POST', '/admin/emails', { to: [atLimit], subject: 'S', text: 'T' })).status).toBe(202)
    expect((await call('POST', '/admin/emails', { to: [overLimit], subject: 'S', text: 'T' })).status).toBe(400)
  })

  it('refuses a reply_to that is not an address', async () => {
    for (const replyTo of ['not-an-email', 'fran@', '@franciscosolis.cl', 'fran@ franciscosolis.cl']) {
      const response = await call('POST', '/admin/emails', {
        to: ['a@example.com'],
        subject: 'S',
        text: 'T',
        reply_to: replyTo,
      })
      expect(response.status, replyTo).toBe(400)
    }

    expect(sent).toHaveLength(0)
    expect(await countRows('email_messages')).toBe(0)
  })

  it('carries a valid reply_to through to the binding and the log', async () => {
    const message = await dataOf<LoggedMessage>(
      await call('POST', '/admin/emails', {
        to: ['a@example.com'],
        subject: 'S',
        text: 'T',
        reply_to: '  Fran@Example.com  ',
      }),
    )

    // Trimmed but not lowercased: the local part of an address is case-sensitive per RFC 5321.
    expect(message.reply_to).toBe('Fran@Example.com')
    expect(sent[0]?.replyTo).toBe('Fran@Example.com')
  })

  it('logs nothing when a ceiling is hit', async () => {
    await call('POST', '/admin/emails', { to: ['a@example.com'], subject: 'x'.repeat(500), text: 'T' })

    expect(await countRows('email_messages')).toBe(0)
    expect(sent).toHaveLength(0)
  })
})

describe('POST /admin/emails — the sender allowlist', () => {
  it('accepts an allowlisted sender', async () => {
    const message = await dataOf<LoggedMessage>(
      await call('POST', '/admin/emails', {
        to: ['a@example.com'],
        subject: 'S',
        text: 'T',
        from: 'no-reply@mail.franciscosolis.cl',
      }),
    )

    expect(message.from_email).toBe('no-reply@mail.franciscosolis.cl')
  })

  it('normalises case before comparing', async () => {
    const message = await dataOf<LoggedMessage>(
      await call('POST', '/admin/emails', {
        to: ['a@example.com'],
        subject: 'S',
        text: 'T',
        from: 'No-Reply@Mail.FranciscoSolis.CL',
      }),
    )

    expect(message.from_email).toBe('no-reply@mail.franciscosolis.cl')
  })

  it('400s a sender that is not on the allowlist, and sends nothing', async () => {
    const response = await call('POST', '/admin/emails', {
      to: ['a@example.com'],
      subject: 'S',
      text: 'T',
      from: 'evil@elsewhere.com',
    })

    expect(response.status).toBe(400)
    expect(await errorOf(response)).toContain('Sender evil@elsewhere.com is not allowed')
    expect(sent).toHaveLength(0)
    expect(await countRows('email_messages')).toBe(0)
  })

  it('400s a lookalike of an allowed sender', async () => {
    for (const from of ['hola@mail.franciscosolis.cl.evil.com', 'hola@franciscosolis.cl', 'hola@mail.franciscosolis.club']) {
      const response = await call('POST', '/admin/emails', { to: ['a@example.com'], subject: 'S', text: 'T', from })
      expect(response.status, from).toBe(400)
    }
  })

  it('falls back to MAIL_FROM_EMAIL when no sender is named', async () => {
    const message = await dataOf<LoggedMessage>(
      await call('POST', '/admin/emails', { to: ['a@example.com'], subject: 'S', text: 'T' }),
    )

    expect(message.from_email).toBe('hola@mail.franciscosolis.cl')
    expect(message.from_name).toBe('Francisco Solis')
  })
})

describe('POST /admin/emails — the house layout', () => {
  it('wraps an HTML body in the shared shell by default', async () => {
    const message = await dataOf<LoggedMessage>(
      await call('POST', '/admin/emails', { to: ['a@example.com'], subject: 'Hola', html: '<p>Body</p>' }),
    )

    expect(message.html).toContain('<!DOCTYPE html')
    // The editor's markup survives untouched inside the shell.
    expect(message.html).toContain('<p>Body</p>')
    // Same footer the auth Worker's mail carries, which is the whole point of sharing the package.
    expect(message.html).toContain('franciscosolis.cl')
  })

  it('gives an HTML-only message the plain-text alternative it used to go out without', async () => {
    await call('POST', '/admin/emails', { to: ['a@example.com'], subject: 'Hola', html: '<p>Body</p>' })

    expect(sent[0]?.text).toContain('Body')
  })

  it('never overwrites a plain-text body the editor wrote', async () => {
    const message = await dataOf<LoggedMessage>(
      await call('POST', '/admin/emails', {
        to: ['a@example.com'],
        subject: 'Hola',
        html: '<p>Body</p>',
        text: 'Mine',
      }),
    )

    expect(message.text).toBe('Mine')
  })

  it('leaves a text-only message alone rather than promoting it to HTML', async () => {
    // Adding an HTML part is a change of intent, not of styling.
    const message = await dataOf<LoggedMessage>(
      await call('POST', '/admin/emails', { to: ['a@example.com'], subject: 'Hola', text: 'Body' }),
    )

    expect(message.html).toBeNull()
    expect(message.text).toBe('Body')
  })

  it('titles the card with the subject, or with `heading` when one is given', async () => {
    const bySubject = await dataOf<LoggedMessage>(
      await call('POST', '/admin/emails', { to: ['a@example.com'], subject: 'Hola', html: '<p>Body</p>' }),
    )
    const byHeading = await dataOf<LoggedMessage>(
      await call('POST', '/admin/emails', {
        to: ['a@example.com'],
        subject: 'Hola',
        heading: 'Something else',
        html: '<p>Body</p>',
      }),
    )

    expect(bySubject.html).toContain('>Hola</h1>')
    expect(byHeading.html).toContain('>Something else</h1>')
  })

  it('stores the wrapped body, so the log is what was actually sent', async () => {
    const message = await dataOf<LoggedMessage>(
      await call('POST', '/admin/emails', { to: ['a@example.com'], subject: 'Hola', html: '<p>Body</p>' }),
    )

    expect((await rawRow(message.id))?.html).toBe(sent[0]?.html)
  })

  it('refuses a layout it does not know instead of silently defaulting', async () => {
    const response = await call('POST', '/admin/emails', {
      to: ['a@example.com'],
      subject: 'Hola',
      html: '<p>Body</p>',
      layout: 'fancy',
    })

    expect(response.status).toBe(400)
    expect(await countRows('email_messages')).toBe(0)
  })
})

describe('POST /admin/emails — templates', () => {
  const template = () =>
    seedTemplate({
      slug: 'welcome',
      name: 'Welcome',
      subject: 'Hola {{ name }}',
      html: '<p>{{ name }}, welcome to {{ site }}</p>',
      text: 'Hola {{ name }}',
      variables: '["name","site"]',
    })

  it('renders the template into the message it sends', async () => {
    await template()

    const message = await dataOf<LoggedMessage>(
      await call('POST', '/admin/emails', {
        to: ['a@example.com'],
        template: 'welcome',
        variables: { name: 'Fran', site: 'franciscosolis.cl' },
      }),
    )

    expect(message.subject).toBe('Hola Fran')
    // The rendered body is what ends up inside the house layout, not what is stored verbatim.
    expect(message.html).toContain('<p>Fran, welcome to franciscosolis.cl</p>')
    expect(message.text).toBe('Hola Fran')
    expect(message.template_slug).toBe('welcome')
  })

  it('refuses a send that is missing a template variable', async () => {
    // Sending "Hola ," to a real person is worse than refusing the request.
    await template()

    const response = await call('POST', '/admin/emails', {
      to: ['a@example.com'],
      template: 'welcome',
      variables: { name: 'Fran' },
    })

    expect(response.status).toBe(400)
    expect(await errorOf(response)).toBe('Missing values for template variables: site')
    expect(sent).toHaveLength(0)
    expect(await countRows('email_messages')).toBe(0)
  })

  it('names every missing variable at once', async () => {
    await template()

    const response = await call('POST', '/admin/emails', { to: ['a@example.com'], template: 'welcome' })

    expect(await errorOf(response)).toBe('Missing values for template variables: name, site')
  })

  it('accepts an empty string as a variable value', async () => {
    await template()

    const message = await dataOf<LoggedMessage>(
      await call('POST', '/admin/emails', {
        to: ['a@example.com'],
        template: 'welcome',
        variables: { name: '', site: 'x' },
      }),
    )

    expect(message.subject).toBe('Hola ')
  })

  it('lets an inline subject override the template\'s', async () => {
    await template()

    const message = await dataOf<LoggedMessage>(
      await call('POST', '/admin/emails', {
        to: ['a@example.com'],
        template: 'welcome',
        variables: { name: 'Fran', site: 'x' },
        subject: 'One-off subject',
      }),
    )

    expect(message.subject).toBe('One-off subject')
    expect(message.text).toBe('Hola Fran')
  })

  it('lets an inline body replace the rendered one entirely', async () => {
    await template()

    const message = await dataOf<LoggedMessage>(
      await call('POST', '/admin/emails', {
        to: ['a@example.com'],
        template: 'welcome',
        variables: { name: 'Fran', site: 'x' },
        html: '<p>Replaced</p>',
      }),
    )

    expect(message.html).toContain('<p>Replaced</p>')
    expect(message.html).not.toContain('welcome to')
    expect(message.text).toBe('Hola Fran')
  })

  it('404s a template slug that does not exist', async () => {
    const response = await call('POST', '/admin/emails', { to: ['a@example.com'], template: 'nope' })

    expect(response.status).toBe(404)
    expect(await errorOf(response)).toBe('No template with slug "nope"')
    expect(await countRows('email_messages')).toBe(0)
  })

  it('lowercases the slug it looks the template up by', async () => {
    await template()

    const response = await call('POST', '/admin/emails', {
      to: ['a@example.com'],
      template: '  WELCOME  ',
      variables: { name: 'Fran', site: 'x' },
    })

    expect(response.status).toBe(202)
  })

  it('does not escape a value it interpolates into the html body', async () => {
    // Documented and deliberate: an editor authors the whole document, so escaping here would
    // corrupt intentional markup.
    await template()

    const message = await dataOf<LoggedMessage>(
      await call('POST', '/admin/emails', {
        to: ['a@example.com'],
        template: 'welcome',
        variables: { name: '<b>Fran</b>', site: 'x' },
      }),
    )

    expect(message.html).toContain('<p><b>Fran</b>, welcome to x</p>')
  })
})

describe('POST /admin/emails — a provider failure', () => {
  it('is a 202 carrying status "failed", not an HTTP error', async () => {
    // The attempt was recorded either way, and the caller needs the id to find it.
    nextResult = new Error('provider unavailable')

    const response = await call('POST', '/admin/emails', { to: ['a@example.com'], subject: 'S', text: 'T' })
    const message = await dataOf<LoggedMessage>(response)

    expect(response.status).toBe(202)
    expect(message.status).toBe('failed')
    expect(message.error).toBe('provider unavailable')
    expect(message.message_id).toBeNull()
  })

  it('still leaves the attempt in the log', async () => {
    nextResult = new Error('provider unavailable')

    const message = await dataOf<LoggedMessage>(
      await call('POST', '/admin/emails', { to: ['a@example.com'], subject: 'S', text: 'T' }),
    )

    expect(await rawRow(message.id)).toMatchObject({ status: 'failed', error: 'provider unavailable' })
  })

  it('is audited as email.failed rather than email.sent', async () => {
    nextResult = new Error('nope')

    const message = await dataOf<LoggedMessage>(
      await call('POST', '/admin/emails', { to: ['a@example.com'], subject: 'S', text: 'T' }),
    )

    const [row] = await readAuditLog()
    expect(row?.event).toBe('email.failed')
    expect(row?.resource_id).toBe(message.id)
    expect(row?.metadata).toEqual({ recipients: 1, template: null, status: 'failed' })
  })
})

describe('POST /admin/emails — the audit trail', () => {
  it('records the shape of the send, never the recipients', async () => {
    // Recipients live on the message row; the trail only needs the count.
    await seedTemplate({ slug: 'welcome', subject: 'Fixed', text: 'Fixed', variables: '[]' })

    const message = await dataOf<LoggedMessage>(
      await call('POST', '/admin/emails', { to: ['a@example.com', 'b@example.com'], template: 'welcome' }),
    )

    const [row] = await readAuditLog()
    expect(row?.event).toBe('email.sent')
    expect(row?.resource_type).toBe('email_messages')
    expect(row?.resource_id).toBe(message.id)
    expect(row?.metadata).toEqual({ recipients: 2, template: 'welcome', status: 'sent' })
    expect(JSON.stringify(row?.metadata)).not.toContain('a@example.com')
  })
})

describe('GET /admin/emails', () => {
  it('lists the log newest first', async () => {
    // `created_at` is unix seconds, so three messages sent inside one test all land in the same
    // second and cannot tell an ordered listing from an unordered one. Seeded seconds apart
    // instead, which is what actually pins `orderBy(desc(createdAt))`.
    const now = Math.floor(Date.now() / 1000)
    for (const [index, subject] of ['oldest', 'middle', 'newest'].entries()) {
      await seedMessage({ subject, createdAt: new Date((now - 30 + index * 10) * 1000) })
    }

    const messages = await dataOf<LoggedMessage[]>(await call('GET', '/admin/emails'))

    expect(messages.map((message) => message.subject)).toEqual(['newest', 'middle', 'oldest'])
  })

  it('pages through that order rather than restarting it', async () => {
    const now = Math.floor(Date.now() / 1000)
    for (const [index, subject] of ['oldest', 'middle', 'newest'].entries()) {
      await seedMessage({ subject, createdAt: new Date((now - 30 + index * 10) * 1000) })
    }

    expect(
      (await dataOf<LoggedMessage[]>(await call('GET', '/admin/emails?limit=2'))).map((m) => m.subject),
    ).toEqual(['newest', 'middle'])
    expect(
      (await dataOf<LoggedMessage[]>(await call('GET', '/admin/emails?limit=2&offset=2'))).map((m) => m.subject),
    ).toEqual(['oldest'])
  })

  it('lists every message that went through the route', async () => {
    for (const subject of ['first', 'second', 'third']) {
      await call('POST', '/admin/emails', { to: ['a@example.com'], subject, text: 'T' })
    }

    const messages = await dataOf<LoggedMessage[]>(await call('GET', '/admin/emails'))

    expect(messages).toHaveLength(3)
    expect(messages.map((message) => message.subject).sort()).toEqual(['first', 'second', 'third'])
  })

  it('filters by status', async () => {
    await call('POST', '/admin/emails', { to: ['a@example.com'], subject: 'ok', text: 'T' })
    nextResult = new Error('nope')
    await call('POST', '/admin/emails', { to: ['a@example.com'], subject: 'bad', text: 'T' })

    expect(await dataOf<LoggedMessage[]>(await call('GET', '/admin/emails?status=sent'))).toHaveLength(1)
    expect(await dataOf<LoggedMessage[]>(await call('GET', '/admin/emails?status=failed'))).toHaveLength(1)
    expect(await dataOf<LoggedMessage[]>(await call('GET', '/admin/emails?status=queued'))).toHaveLength(0)
  })

  it('rejects a status outside the closed set', async () => {
    expect((await call('GET', '/admin/emails?status=bounced')).status).toBe(400)
  })

  it('pages with limit and offset', async () => {
    for (const subject of ['a', 'b', 'c']) {
      await call('POST', '/admin/emails', { to: ['x@example.com'], subject, text: 'T' })
    }

    expect(await dataOf<LoggedMessage[]>(await call('GET', '/admin/emails?limit=2'))).toHaveLength(2)
    expect(await dataOf<LoggedMessage[]>(await call('GET', '/admin/emails?offset=99'))).toHaveLength(0)
    expect((await call('GET', '/admin/emails?limit=201')).status).toBe(400)
  })

  it('is never cached', async () => {
    expect((await call('GET', '/admin/emails')).headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('GET /admin/emails/:id', () => {
  it('returns the message with the body exactly as it was sent', async () => {
    const created = await dataOf<LoggedMessage>(
      await call('POST', '/admin/emails', { to: ['a@example.com'], subject: 'S', html: '<p>Body</p>' }),
    )

    const message = await dataOf<LoggedMessage>(await call('GET', `/admin/emails/${created.id}`))
    expect(message.id).toBe(created.id)
    expect(message.html).toContain('<p>Body</p>')
    expect(message.to).toEqual(['a@example.com'])
  })

  it('404s an id that does not exist', async () => {
    const response = await call('GET', '/admin/emails/nope')

    expect(response.status).toBe(404)
    expect(await errorOf(response)).toBe('Message not found')
  })
})

describe('the real Cloudflare Email Sending binding', () => {
  it('carries a send through end to end', async () => {
    // The recorder is swapped back out here so the route is exercised against miniflare's own
    // implementation of the binding, sender allowlist and all.
    env.EMAIL = realEmail

    const response = await call('POST', '/admin/emails', {
      to: ['someone@example.com'],
      subject: 'Through the real binding',
      text: 'Body',
      from: 'no-reply@mail.franciscosolis.cl',
    })
    const message = await dataOf<LoggedMessage>(response)

    expect(response.status).toBe(202)
    expect(message.status).toBe('sent')
    expect(message.message_id).toEqual(expect.any(String))
    expect((await rawRow(message.id))?.status).toBe('sent')
  })
})
