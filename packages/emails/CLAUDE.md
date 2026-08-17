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
- `src/theme.ts` — colours, font stack, widths. The only place a hex code belongs.
- `src/render.ts` — `renderEmail`, the primitive every template's wrapper calls.
- `src/components/` — `email-layout.tsx` (the shell), `action-link.tsx`, `paragraph.tsx`.
- `src/templates/` — one file per email. Also the directory the preview server reads.
- `src/prettier-stub.ts` — not a template; see the bundle note below.

## Architecture notes (non-obvious)

- **Every `.tsx` starts with `/** @jsxImportSource react */`.** The rest of the monorepo
  compiles JSX with `hono/jsx` (see the root and per-app `tsconfig.json`), and these files
  are compiled by the *consuming Worker's* bundler, which reads that Worker's tsconfig —
  not this package's. The per-file pragma is what makes the setting irrelevant. Dropping it
  from a new template produces `hono/jsx` elements that react-email cannot render.
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
