import type { Env } from '@/env'

/** Escapes text before it is interpolated into an HTML email body. */
const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

type Template = {
  subject: string
  html: string
  text: string
}

/**
 * Shared shell for every email this Worker sends. Inline styles only, a single centred column and
 * no external assets — email clients strip <style> blocks and block remote images by default.
 */
const layout = ({ title, intro, buttonLabel, url, outro }: {
  title: string
  intro: string
  buttonLabel: string
  url: string
  outro: string
}) => `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#0b0b0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#15151c;border-radius:12px;">
      <tr>
        <td style="padding:32px;">
          <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#f4f4f5;">${escapeHtml(title)}</h1>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#a1a1aa;">${escapeHtml(intro)}</p>
          <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 24px;border-radius:8px;background:#6366f1;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">${escapeHtml(buttonLabel)}</a>
          <p style="margin:24px 0 8px;font-size:13px;line-height:1.6;color:#71717a;">If the button does not work, copy this link into your browser:</p>
          <p style="margin:0 0 24px;font-size:13px;line-height:1.6;word-break:break-all;"><a href="${escapeHtml(url)}" style="color:#818cf8;">${escapeHtml(url)}</a></p>
          <p style="margin:0;font-size:13px;line-height:1.6;color:#71717a;">${escapeHtml(outro)}</p>
        </td>
      </tr>
    </table>
  </body>
</html>`

const magicLinkTemplate = ({ url, applicationName, expiresInMinutes }: {
  url: string
  applicationName: string
  expiresInMinutes: number
}): Template => ({
  subject: `Your sign-in link for ${applicationName}`,
  html: layout({
    title: `Sign in to ${applicationName}`,
    intro: `Use the button below to finish signing in. The link works once and expires in ${expiresInMinutes} minutes.`,
    buttonLabel: 'Sign in',
    url,
    outro: 'If you did not request this link, you can ignore this email — nobody can sign in without it.',
  }),
  text: [
    `Sign in to ${applicationName}`,
    '',
    `Open this link to finish signing in. It works once and expires in ${expiresInMinutes} minutes:`,
    url,
    '',
    'If you did not request this link, you can ignore this email — nobody can sign in without it.',
  ].join('\n'),
})

const invitationTemplate = ({ url, applicationName, invitedByName, expiresInDays }: {
  url: string
  applicationName: string
  invitedByName: string | null
  expiresInDays: number
}): Template => ({
  subject: `You have been invited to ${applicationName}`,
  html: layout({
    title: `You have been invited to ${applicationName}`,
    intro: invitedByName
      ? `${invitedByName} invited you to ${applicationName}. Sign in with this email address to accept — the invitation expires in ${expiresInDays} days.`
      : `You have been invited to ${applicationName}. Sign in with this email address to accept — the invitation expires in ${expiresInDays} days.`,
    buttonLabel: 'Accept invitation',
    url,
    outro: 'The invitation is tied to this email address; signing in with a different one will not work.',
  }),
  text: [
    `You have been invited to ${applicationName}`,
    '',
    invitedByName ? `${invitedByName} invited you.` : 'You have been invited.',
    `Sign in with this email address to accept. The invitation expires in ${expiresInDays} days:`,
    url,
    '',
    'The invitation is tied to this email address; signing in with a different one will not work.',
  ].join('\n'),
})

/**
 * Hands a message to Cloudflare Email Sending. The sender identity is fixed by `MAIL_FROM_NAME` /
 * `MAIL_FROM_EMAIL` and is also pinned in wrangler.jsonc via `allowed_sender_addresses`, so a bug
 * elsewhere cannot make the Worker send as some other address.
 */
const sendEmail = async (env: Env, to: string, template: Template) => {
  const result = await env.EMAIL.send({
    from: { email: env.MAIL_FROM_EMAIL, name: env.MAIL_FROM_NAME },
    to: [to],
    subject: template.subject,
    html: template.html,
    text: template.text,
  })
  return result.messageId
}

export { invitationTemplate, magicLinkTemplate, sendEmail }
export type { Template }
