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

- **One house style, and it is the brand's** — the palette in `src/theme.ts` is the published
  FranciscoSolis identity: iris accent, ink copy, the 45° periwinkle→plum gradient, and the
  horizontal lockup at the head of every card.
- **Built to survive a hostile client** — light-first, every surface declared twice, an explicit
  light colour scheme and a flat fallback under the gradient. See below for what each of those is
  defending against.
- **Escaping by construction** — values are React children, so markup in an application name or an
  inviter's name is escaped rather than injected. No `escapeHtml` helper to remember to call.
- **A plain-text part that cannot drift** — the text alternative is derived from the rendered HTML,
  not maintained alongside it.
- **A real preview** — `pnpm run preview` opens every template in a browser with sample props, so a
  change can be looked at without sending anything.
- **Inline styles only** — mail clients strip `<style>` blocks, so every rule ends up on the
  element, and no web fonts: `@font-face` is ignored by Outlook and Gmail's web client. The one
  remote asset is the logo, which cannot be anything else (see below).

---

## 🧩 What is in it

| Export | What it is |
|--------|------------|
| `renderMagicLinkEmail` | Single-use sign-in link. Used by `apps/auth`. |
| `renderInvitationEmail` | Invitation to an address an admin has just allowed in. Used by `apps/auth`. |
| `renderContentEmail` | Wrapper around an editor-authored body. Used by `apps/cms`. |
| `renderEmail` | The primitive the three above are built on: element in, `{ subject, html, text }` out. |
| `EmailLayout`, `ActionLink`, `Paragraph` | The building blocks a new template is assembled from. |
| `theme` | The design tokens — palette, gradient, logo, widths. |
| `palette` | The raw brand colours `theme` is composed from. |

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

## 🎨 The palette, and why it is light

These templates used to be a dark card — near-black page, `#15151c` surface, `#a1a1aa` body copy.
That is the single least robust thing an email body can be. Outlook.com and Gmail's web client both
rewrite colours they take to be part of a theme, and a dark card is exactly the shape they target:
the background gets forced back to white and the text keeps the pale grey it was authored in, so the
message lands as light grey on white — around 2.4:1, which is unreadable. Apple Mail and iOS have
the mirror-image problem, auto-inverting a message that already chose its colours.

The palette is now the brand's light one, which gives those rewriters nothing to fix:

| Role | Token | Value |
|------|-------|-------|
| Page | `iris-050` | `#f4f1f9` |
| Card | white | `#ffffff` |
| Heading and body copy | `ink` | `#1e1e1e` |
| Small print | `ink` at 70% over white | `#616161` |
| Buttons, links, the accent | `iris-500` | `#75549c` |
| Gradient rule | `periwinkle-500` → `plum-500`, 45° | `#5a68c4` → `#8a4270` |

Nothing pairs below **5.3:1** on either surface it is allowed to appear on; body copy is 17.4:1.

Four defences hold that up, and all four are load-bearing:

1. **`<meta name="color-scheme" content="light">`** (and `supported-color-schemes`) stops Apple
   Mail, iOS Mail and Outlook for Mac from auto-inverting.
2. **`bgcolor` next to every `background-color`.** The attribute is the older, dumber mechanism, and
   it is the one Outlook's Word engine and several webmail sanitisers actually honour.
3. **The page background is painted by a wrapper table, not only by `<body>`** — Gmail and several
   webmail clients drop the `<body>` element and keep its children.
4. **The gradient rule carries a flat `iris-500` underneath it.** Outlook ignores
   `background-image` outright; the brand guidelines nominate the flat accent as the fallback.

There is no `@media (prefers-color-scheme: dark)` block, because there is no `<style>` block at all
— the design has to survive a client that keeps only inline attributes. Light-first is what replaces
it.

---

## 🖼️ The logo

`EmailLayout` renders the horizontal lockup from
`https://api.franciscosolis.cl/brand/lockup.png`, served by [`apps/api`](../../apps/api/README.md)
from `src/brand.ts`. It has to be a hosted HTTP asset: Gmail strips inline SVG and blocks `data:`
URIs, so neither the SVG source nor an embedded copy would reach an inbox.

Two details are deliberate. The PNG is **flattened onto white** rather than transparent — a client
that repaints the card dark does not repaint image pixels, and a transparent lockup would put
ink-coloured "Solis" on a dark surface and lose the word. And the `alt` text is the wordmark, so a
recipient with images off still sees the brand name.

The committed source is `assets/lockup.png`, a 400×66 (2×) render of `fs-lockup-horizontal` from the
brand package, displayed at 200×33. To replace it, re-render the asset and re-encode it into
`apps/api/src/brand.ts`:

```bash
node -e "console.log(require('fs').readFileSync('packages/emails/assets/lockup.png').toString('base64'))"
```

The ETag that Worker serves is derived from the bytes, so a replaced asset invalidates caches on its
own.

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
