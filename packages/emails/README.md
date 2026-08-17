<div align="center">

# ✉️ @franciscosolis/emails — Shared Email Templates

**Every email the `api.franciscosolis.cl` Workers send, written once as [react-email](https://react.email) components and previewable in a browser.**

[![License](https://img.shields.io/badge/license-GPL--3.0--only-blue)](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE)

</div>

---

## 📖 Overview

Two Workers in this monorepo send mail — [`apps/auth`](../../apps/auth/README.md) (sign-in links
and invitations) and [`apps/cms`](../../apps/cms/README.md) (editorial messages). Before this
package they each assembled their own HTML with template literals, which meant hand-escaping every
interpolated value, hand-writing a plain-text twin of each body, and two subtly different visual
identities arriving from the same domain.

This package is where those bodies live now. A Worker imports one function, gets back
`{ subject, html, text }`, and hands it to its Cloudflare Email Sending binding. It never assembles
markup itself.

The package ships **TypeScript source, not a build**. Wrangler already bundles each Worker with
esbuild, so a build step here would only add an artifact to keep in sync.

---

## ✨ What it gives you

- **One house style** — colours, spacing, the font stack and the card layout are tokens in
  `src/theme.ts` and a single `EmailLayout`. A sign-in link and a newsletter arrive looking like the
  same sender.
- **Escaping by construction** — values are React children, so markup in an application name or an
  inviter's name is escaped rather than injected. No `escapeHtml` helper to remember to call.
- **A plain-text part that cannot drift** — the text alternative is derived from the rendered HTML,
  not maintained alongside it.
- **A real preview** — `pnpm run preview` opens every template in a browser with sample props, so a
  change can be looked at without sending anything.
- **Inline styles only** — mail clients strip `<style>` blocks, so every rule ends up on the element.
  No web fonts and no remote images either; both are routinely blocked.

---

## 🧩 What is in it

| Export | What it is |
|--------|------------|
| `renderMagicLinkEmail` | Single-use sign-in link. Used by `apps/auth`. |
| `renderInvitationEmail` | Invitation to an address an admin has just allowed in. Used by `apps/auth`. |
| `renderContentEmail` | Wrapper around an editor-authored body. Used by `apps/cms`. |
| `renderEmail` | The primitive the three above are built on: element in, `{ subject, html, text }` out. |
| `EmailLayout`, `ActionLink`, `Paragraph` | The building blocks a new template is assembled from. |
| `theme` | The design tokens. |

Each template also exports the React component itself (`MagicLinkEmail`, …) plus a default export
and `PreviewProps`, which is what the preview server reads.

---

## 🚀 Usage

```ts
import { renderMagicLinkEmail } from '@franciscosolis/emails'

const message = await renderMagicLinkEmail({
  url: signInUrl,
  applicationName: application.name,
  expiresInMinutes: 15,
  brandName: env.MAIL_FROM_NAME,
})

await env.EMAIL.send({
  from: { email: env.MAIL_FROM_EMAIL, name: env.MAIL_FROM_NAME },
  to: [address],
  subject: message.subject,
  html: message.html,
  text: message.text,
})
```

Rendering is asynchronous — `render` server-renders through React — so every `render*Email` returns
a promise.

---

## 👀 Previewing

```bash
pnpm --filter @franciscosolis/emails run preview   # http://localhost:8791
```

The preview server reads `src/templates/`, so every file there needs a default export and a
`PreviewProps` object with realistic sample values. `pnpm run export` writes the same set out as
static HTML, which is what to hand to a rendering-compatibility checker.

---

## 🧱 Adding a template

1. Create `src/templates/<name>.tsx`. Start it with `/** @jsxImportSource react */` — the rest of
   this monorepo compiles JSX with `hono/jsx`, and the pragma is what keeps these files on React
   regardless of which Worker's bundler picks them up.
2. Build it out of `EmailLayout` + `Paragraph` + `ActionLink` rather than raw elements, so it
   inherits the house style instead of re-deriving it.
3. Export the component, a `render<Name>Email` wrapper that supplies the subject, `PreviewProps`,
   and a default export.
4. Re-export it from `src/index.ts`.
5. Cover it from the consuming Worker's suite. Tests live there on purpose: those run inside
   `workerd`, which is the runtime that actually has to render the thing.

---

## ⚠️ Prettier is aliased out of the Workers

`@react-email/render` imports Prettier at the top of its module to implement its `pretty: true`
option. A static import is unconditional, so esbuild pulls ~1.5 MB of formatter into any Worker that
imports this package — and pays to parse it on every cold start — even though `renderEmail` always
renders with `pretty: false`.

Both mail-sending Workers therefore point `prettier/standalone` and `prettier/plugins/html` at
`src/prettier-stub.ts` through the `alias` block in their `wrangler.jsonc`, and restate the same
aliases in their `vitest.config.ts` so the suite exercises the Worker as it actually ships. The stub
throws if anything ever calls it. If it does, drop the alias rather than keeping a formatter that
silently does nothing.

---

## 📄 License

Licensed under the **GNU General Public License v3.0** — see [LICENSE](../../LICENSE).
