# CLAUDE.md

## LANGUAGE RULE — MANDATORY, NO EXCEPTIONS

ALL code, comments, variable/function names, commit messages, PR descriptions, and any
other written content in this repository MUST be in English. This applies regardless of
the language the user writes to Claude Code in. Never write Spanish (or any other
language) into files, commits, or code in this repo.

## Purpose

`@franciscosolis/emails` holds every email body the monorepo sends, written as
[react-email](https://react.email) components. `apps/auth` uses it for magic links and
invitations, `apps/cms` for editorial messages. It is the first entry under `packages/`
and the only non-Worker workspace package.

A consumer imports a `render*Email` function, gets `{ subject, html, text }` and hands
that to its Cloudflare Email Sending binding. No Worker builds markup itself any more.

## Commands (run from the repo root)

- `pnpm --filter @franciscosolis/emails run preview` → react-email dev server on :8791.
- `pnpm --filter @franciscosolis/emails run export` → the same templates as static HTML.
- `pnpm --filter @franciscosolis/emails run typecheck` → `tsc --noEmit`.

There is no `dev`, `build`, `deploy` or `test` script, so the root `-r` scripts skip this
package. That is deliberate on all four counts — see below.

## Source layout

- `src/index.ts` — the public API. Anything a Worker imports has to be re-exported here.
- `src/theme.ts` — `palette` (the brand's published colours) and `theme` (what the components
  actually reference). The only place a hex code belongs.
- `src/render.ts` — `renderEmail`, the primitive every template's wrapper calls.
- `src/components/` — `email-layout.tsx` (the shell), `action-link.tsx`, `paragraph.tsx`.
- `src/templates/` — one file per email. Also the directory the preview server reads.
- `src/prettier-stub.ts` — not a template; see the bundle note below.
- `assets/lockup.png` — the logo the layout points at. The bytes that actually get served live in
  `apps/api/src/brand.ts`; this is the source they were encoded from.

## Architecture notes (non-obvious)

- **Every `.tsx` starts with `/** @jsxImportSource react */`.** The rest of the monorepo
  compiles JSX with `hono/jsx` (see the root and per-app `tsconfig.json`), and these files
  are compiled by the *consuming Worker's* bundler, which reads that Worker's tsconfig —
  not this package's. The per-file pragma is what makes the setting irrelevant. Dropping it
  from a new template produces `hono/jsx` elements that react-email cannot render.
- **Components come from `react-email` itself, not `@react-email/components`.** react-email v6
  folded the component set into the main package and deprecated `@react-email/components` (and
  every `@react-email/<component>` package under it) on npm. Importing from the old name still
  resolves today, but it installs 21 unmaintained packages, so do not reinstate it. `@react-email/render`
  is the one scoped package that is still current — it is not part of that deprecation.
  Nothing else changed: same component names, same props. The heavy extras the unified package
  ships (`tailwindcss`, `prismjs`, `marked` behind `Tailwind`, `CodeBlock` and `Markdown`) are
  declared `sideEffects: false` and tree-shake out, so the Worker bundles moved by ~3 KiB raw
  and not at all after gzip. Importing one of *those* three components would drag all of it in.

- **No `@/*` alias here, imports are relative.** For the same reason: in a Worker's bundle
  `@/*` already points at that Worker's own `src/`.
- **The package ships source, not a build.** Wrangler bundles each Worker with esbuild and
  resolves straight through the pnpm workspace symlink, so a build step would only add a
  stale artifact. This is also why there is no `build` script for the root `-r build` to run.
- **Tests live in the consuming apps, not here.** Rendering has to work inside `workerd`,
  and `apps/auth`'s and `apps/cms`'s suites already run there via
  `@cloudflare/vitest-pool-workers`. A Node-side suite here would pass on code paths the
  Workers never take. `apps/auth/test/unit/email.test.ts` is the reference.
- **The plain-text part is derived, never authored.** `renderEmail` renders the HTML once
  and converts it, so the two bodies cannot drift apart. It also turns off html-to-text's
  default heading upper-casing, which reads as shouting and scores badly with spam filters.
- **Prettier is aliased away in the Workers, not here.** `@react-email/render` imports it
  statically for its `pretty: true` option, which drags ~1.5 MB into any bundle that touches
  this package. Both Workers alias `prettier/standalone` and `prettier/plugins/html` to
  `src/prettier-stub.ts` in `wrangler.jsonc`, *and* restate the aliases in their
  `vitest.config.ts` so the suite runs against the same module graph that deploys. The stub
  throws rather than no-ops: a react-email version that genuinely needs the formatter should
  fail loudly.
- **`ContentEmail` inserts its body with `dangerouslySetInnerHTML`, deliberately.** It exists
  to wrap markup an authenticated CMS editor wrote; that editor already controls the whole
  document, and re-serialising their HTML would silently rewrite it. Do not point any
  unauthenticated input at it.
- **`PreviewProps` and the default export are load-bearing**, not decoration: the preview
  server enumerates `src/templates/` and needs both. A template without them silently
  disappears from the preview.
- **The palette is light-first, and that is a compatibility decision, not a taste one.** It used to
  be a dark card with `#a1a1aa` body copy. Outlook.com and Gmail's web client rewrite colours they
  read as a theme — they force the surface back to white and leave the text grey, which lands at
  about 2.4:1. A light design gives them nothing to fix. Four things hold that up and none of them
  are decoration: the `color-scheme`/`supported-color-schemes` metas in `<Head>` (Apple Mail and iOS
  auto-invert without them), a `bgcolor` attribute beside every `background-color` (the attribute is
  what Outlook's Word engine honours), the page background painted by a wrapper `<Section>` rather
  than only `<body>` (Gmail drops `<body>` and keeps its children), and the flat `iris-500` under
  the gradient rule (Outlook ignores `background-image`). Removing any one of them reintroduces a
  specific broken client. `theme.ts` carries the contrast table.
- **There must be no `<style>` block.** `apps/auth`'s suite asserts it, and the reason it asserts it
  is that the whole design has to survive a sanitiser that keeps only inline attributes. This is
  what rules out `@media (prefers-color-scheme: dark)` and is why the palette is light-first instead
  of adaptive. It is also why `PLAIN_TEXT_SKIP_CLASS` is a class name — a class attribute costs
  nothing in a mail client and is the one hook html-to-text can select on.
- **The logo is a hosted PNG, and every property of it is forced.** Gmail strips inline SVG and
  blocks `data:` URIs, so it cannot be embedded; `apps/api` serves it at `/brand/lockup.png` because
  that Worker owns the only public hostname in the repo. It is flattened onto white rather than
  transparent because a client that darkens the card does not darken image pixels — a transparent
  lockup loses the ink-coloured "Solis". Its `alt` is the wordmark, but that does *not* reach the
  plain-text part (`toPlainText` skips images), which is why the footer also names the brand in
  words. Changing the asset means re-encoding `apps/api/src/brand.ts`; see `README.md`.
- **`ContentEmail`'s editor HTML keeps its own link styling.** Anchors inside the injected body come
  out in the client's default blue rather than `iris-500`, because reaching them would mean either a
  `<style>` block or rewriting the editor's markup, and both are ruled out above. Default link blue
  clears AA on white, so this is a known, bounded cosmetic gap — not something to fix by parsing the
  fragment.
