import { env } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { invitationTemplate, magicLinkTemplate, sendEmail, type Template } from '@/services/email'
import { captureEmails } from '../helpers/email'

const mailbox = captureEmails()
afterEach(() => {
  mailbox.sent.length = 0
})

describe('magicLinkTemplate', () => {
  let template: Template

  beforeAll(async () => {
    template = await magicLinkTemplate({
      url: 'https://api.franciscosolis.cl/auth/magic-link/callback?token=abc',
      applicationName: 'franciscosolis.cl',
      expiresInMinutes: 15,
    })
  })

  it('names the application in the subject and the body', () => {
    expect(template.subject).toBe('Your sign-in link for franciscosolis.cl')
    expect(template.html).toContain('Sign in to franciscosolis.cl')
    expect(template.text).toContain('Sign in to franciscosolis.cl')
  })

  it('carries the link in both the HTML and the plain-text part', () => {
    expect(template.text).toContain('https://api.franciscosolis.cl/auth/magic-link/callback?token=abc')
    expect(template.html).toContain('magic-link/callback?token=abc')
  })

  it('tells the recipient how long the link lasts and that it works once', () => {
    expect(template.text).toContain('expires in 15 minutes')
    expect(template.text).toContain('works once')
  })

  it('reassures a recipient who did not ask for it', () => {
    expect(template.text).toContain('If you did not request this link')
  })

  it('embeds its styling inline, since mail clients strip style blocks', () => {
    expect(template.html).not.toContain('<style')
    expect(template.html).toContain('style="')
  })

  it('sets an inbox preview line instead of letting the client invent one', () => {
    // react-email renders `<Preview>` as a hidden block marked `data-skip-in-text`, which is also
    // why it must not turn up in the plain-text alternative.
    expect(template.html).toContain('data-skip-in-text="true"')
    expect(template.text).not.toContain('Your sign-in link for')
  })

  it('leaves the heading in sentence case in the plain-text part', () => {
    // html-to-text upper-cases headings unless told otherwise, which reads as shouting and is a
    // shape spam filters score against.
    expect(template.text).not.toContain('SIGN IN TO')
  })
})

describe('invitationTemplate', () => {
  it('names the inviter when one is known', async () => {
    const template = await invitationTemplate({
      url: 'https://cms.franciscosolis.cl',
      applicationName: 'the CMS',
      invitedByName: 'Ada',
      expiresInDays: 7,
    })

    expect(template.subject).toBe('You have been invited to the CMS')
    expect(template.text).toContain('Ada invited you to the CMS.')
    expect(template.text).toContain('expires in 7 days')
  })

  it('falls back to an impersonal phrasing when the inviter is anonymous', async () => {
    const template = await invitationTemplate({
      url: 'https://cms.franciscosolis.cl',
      applicationName: 'the CMS',
      invitedByName: null,
      expiresInDays: 3,
    })

    expect(template.text).toContain('You have been invited to the CMS.')
    expect(template.text).not.toContain('invited you to')
  })

  it('warns that the invitation is bound to the address it was sent to', async () => {
    const template = await invitationTemplate({
      url: 'https://cms.franciscosolis.cl',
      applicationName: 'the CMS',
      invitedByName: null,
      expiresInDays: 7,
    })

    expect(template.text).toContain('tied to this email address')
  })
})

describe('HTML escaping', () => {
  it('neutralises markup coming from an application name', async () => {
    const template = await magicLinkTemplate({
      url: 'https://api.test/callback?token=abc',
      applicationName: '<script>alert(1)</script>',
      expiresInMinutes: 15,
    })

    expect(template.html).not.toContain('<script>')
    expect(template.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes an inviter name that would otherwise break out of the markup', async () => {
    const template = await invitationTemplate({
      url: 'https://client.test',
      applicationName: 'App',
      invitedByName: '"><img src=x onerror=alert(1)>',
      expiresInDays: 7,
    })

    expect(template.html).not.toContain('<img')
    expect(template.html).toContain('&quot;&gt;&lt;img')
  })

  it('escapes the ampersands inside the link itself', async () => {
    const template = await magicLinkTemplate({
      url: 'https://api.test/cb?token=abc&next=/x',
      applicationName: 'App',
      expiresInMinutes: 15,
    })

    expect(template.html).toContain('href="https://api.test/cb?token=abc&amp;next=/x"')
    // The plain-text part is not markup, so it keeps the URL usable as typed.
    expect(template.text).toContain('https://api.test/cb?token=abc&next=/x')
  })

  it('escapes an apostrophe rather than leaving it to break a single-quoted attribute', async () => {
    const template = await magicLinkTemplate({
      url: 'https://api.test/cb',
      applicationName: "Fran's site",
      expiresInMinutes: 15,
    })

    expect(template.html).toContain('Fran&#x27;s site')
    expect(template.html).not.toContain("Fran's site")
  })
})

describe('sendEmail', () => {
  it('sends from the pinned sender identity and returns the message id', async () => {
    const template = await magicLinkTemplate({
      url: 'https://api.test/cb',
      applicationName: 'App',
      expiresInMinutes: 15,
    })

    await expect(sendEmail(env, 'someone@example.test', template)).resolves.toBe('test-1')

    expect(mailbox.last()).toEqual({
      from: { email: env.MAIL_FROM_EMAIL, name: env.MAIL_FROM_NAME },
      to: ['someone@example.test'],
      subject: template.subject,
      html: template.html,
      text: template.text,
    })
  })

  it('always sends both an HTML and a plain-text part', async () => {
    await sendEmail(env, 'someone@example.test', await invitationTemplate({
      url: 'https://client.test',
      applicationName: 'App',
      invitedByName: null,
      expiresInDays: 7,
    }))

    expect(mailbox.last().html).toBeTruthy()
    expect(mailbox.last().text).toBeTruthy()
  })

  it('propagates a delivery failure instead of swallowing it', async () => {
    const original = env.EMAIL.send
    env.EMAIL.send = async () => {
      throw new Error('mailbox full')
    }

    await expect(
      sendEmail(
        env,
        'someone@example.test',
        await magicLinkTemplate({ url: 'https://a.test', applicationName: 'A', expiresInMinutes: 1 }),
      ),
    ).rejects.toThrow('mailbox full')

    env.EMAIL.send = original
  })
})
