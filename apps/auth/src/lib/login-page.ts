import type { Env } from '@/env'
import type { ProviderName } from '@/lib/config'

/**
 * The sign-in screen this Worker serves when nothing else is configured to serve one.
 *
 * An authorization server is the one part of an OAuth deployment that cannot be pure JSON: the user
 * has to be shown something between `GET /oauth/authorize` and the redirect back. This is that
 * something, and it is deliberately the plainest thing that works — no framework, no build step, no
 * external request, one file. Set `AUTH_LOGIN_URL` to hand the job to a real front-end instead;
 * this page and that front-end drive exactly the same endpoints.
 *
 * Everything interpolated below goes through `escapeHtml`. The values are client names and email
 * addresses, i.e. attacker-influenceable strings, and this is the only place in the Worker that
 * builds markup by hand.
 */

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

type ProviderOption = {
  name: ProviderName
  displayName: string
  initiation: 'email' | 'redirect'
}

type LoginPageInput = {
  env: Env
  /** Opaque handle of the parked authorization request the form posts back to. */
  handle: string
  applicationName: string
  providers: ProviderOption[]
  loginHint: string | null
  /** Rendered above the form, in the error style. */
  error?: string | null
  /** Rendered instead of the form, after a magic link has gone out. */
  notice?: string | null
}

const STYLES = `
  :root {
    color-scheme: light dark;
    --bg: #f6f6f7;
    --card: #ffffff;
    --text: #18181b;
    --muted: #6b7280;
    --border: #e4e4e7;
    --accent: #18181b;
    --accent-text: #ffffff;
    --error: #b91c1c;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #09090b;
      --card: #131316;
      --text: #fafafa;
      --muted: #a1a1aa;
      --border: #27272a;
      --accent: #fafafa;
      --accent-text: #18181b;
      --error: #f87171;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main {
    width: 100%;
    max-width: 380px;
    padding: 32px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--card);
  }
  h1 { margin: 0 0 4px; font-size: 20px; }
  p.lead { margin: 0 0 24px; color: var(--muted); font-size: 14px; }
  label { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 600; }
  input[type="email"] {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
    font: inherit;
  }
  button, a.provider {
    display: block;
    width: 100%;
    margin-top: 12px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--accent);
    color: var(--accent-text);
    font: inherit;
    font-weight: 600;
    text-align: center;
    text-decoration: none;
    cursor: pointer;
  }
  a.provider { background: transparent; color: var(--text); }
  .divider {
    margin: 20px 0;
    border-top: 1px solid var(--border);
    text-align: center;
    font-size: 12px;
    color: var(--muted);
  }
  .divider span { position: relative; top: -9px; padding: 0 8px; background: var(--card); }
  .error, .notice { margin: 0 0 16px; padding: 10px 12px; border-radius: 8px; font-size: 14px; }
  .error { border: 1px solid var(--error); color: var(--error); }
  .notice { border: 1px solid var(--border); color: var(--muted); }
  footer { margin-top: 24px; font-size: 12px; color: var(--muted); text-align: center; }
`

const renderLoginPage = (input: LoginPageInput): string => {
  const { env, handle } = input
  const base = `${env.AUTH_PUBLIC_URL}/oauth/authorize/${encodeURIComponent(handle)}`
  const emailProviders = input.providers.filter((provider) => provider.initiation === 'email')
  const redirectProviders = input.providers.filter((provider) => provider.initiation === 'redirect')

  const form = emailProviders.length === 0 ? '' : `
      <form method="post" action="${escapeHtml(`${base}/magic-link`)}">
        <label for="email">Email address</label>
        <input id="email" name="email" type="email" autocomplete="email" required
               value="${escapeHtml(input.loginHint ?? '')}" placeholder="you@example.com">
        <button type="submit">Email me a sign-in link</button>
      </form>`

  const alternatives = redirectProviders
    .map(
      (provider) =>
        `      <a class="provider" href="${escapeHtml(`${base}/${provider.name.replace(/_/g, '-')}`)}">Continue with ${escapeHtml(provider.displayName)}</a>`,
    )
    .join('\n')

  const divider = form && alternatives ? '      <div class="divider"><span>or</span></div>\n' : ''

  const body = input.notice
    ? `      <p class="notice">${escapeHtml(input.notice)}</p>`
    : `${form}\n${divider}${alternatives}`

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>Sign in to ${escapeHtml(input.applicationName)}</title>
    <style>${STYLES}</style>
  </head>
  <body>
    <main>
      <h1>Sign in</h1>
      <p class="lead">to continue to ${escapeHtml(input.applicationName)}</p>
${input.error ? `      <p class="error">${escapeHtml(input.error)}</p>\n` : ''}${body}
      <footer>${escapeHtml(env.MAIL_FROM_NAME)}</footer>
    </main>
  </body>
</html>
`
}

/** The same chrome, for a failure that has no redirect URI safe enough to report it through. */
const renderErrorPage = (env: Env, title: string, message: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>${escapeHtml(title)}</title>
    <style>${STYLES}</style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p class="error">${escapeHtml(message)}</p>
      <footer>${escapeHtml(env.MAIL_FROM_NAME)}</footer>
    </main>
  </body>
</html>
`

export { escapeHtml, renderErrorPage, renderLoginPage }
export type { LoginPageInput, ProviderOption }
