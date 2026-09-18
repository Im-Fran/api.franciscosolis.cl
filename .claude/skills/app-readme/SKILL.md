---
name: app-readme
description: Write or rewrite the README.md of a Worker app or shared package in this monorepo, in the house style shared by apps/api, apps/landing, apps/auth, apps/cms and packages/emails. Use when a README is missing, drifted from the code, or written in a different style from its siblings, and when a new app or package is added under apps/ or packages/.
---

# App README

Every app under `apps/` and every package under `packages/` ships a `README.md` written to
one house standard. This skill is that standard: the layout, the section order, the voice, and
the rule that nothing in it may be invented.

The reference implementations are `apps/auth/README.md` (the long one), `apps/cms/README.md`
(the balanced one) and `apps/landing/README.md` (the short one). When this file and those
disagree, they win — they are the live style, this is the description of it.

## Before writing anything

A README here documents the code as it is, not as a summary of other prose. Read, for the
target app:

1. `package.json` — the real `scripts`, the real dependencies, the `name` the `--filter` uses.
2. `wrangler.jsonc` — Worker `name`, bindings, `vars`, ports in the `dev` script, D1 databases,
   R2 buckets, service bindings, observability.
3. `src/index.ts` — the mounted routes, the middleware, the error handler.
4. `src/lib/*`, `src/routes/*`, `src/services/*` — what each feature bullet will claim.
5. `migrations/` and `src/db/schema.ts` if the app is stateful.
6. `CLAUDE.md` in the app, and the root `CLAUDE.md` — for the decisions worth surfacing.
7. The app's entry in `apps/api/src/services.ts`, if it is proxied by the gateway.

Never state a route, a variable, a port, a binding, a database name or a command that you have
not read in one of those files. A README that drifts is worse than a short one.

## Layout

In this order. Skip a section only when the app genuinely has nothing for it (a Worker with no
secrets has no "Configuration" table worth writing; a package has no "Deployment").

1. **Centred header block**

   ```markdown
   <div align="center">

   # <emoji> <name> — <three-to-five-word role>

   **One bold sentence saying what this Worker is and where it lives, ending with a period.**

   [![License](https://img.shields.io/badge/license-GPL--3.0--only-blue)](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE)

   </div>

   ---
   ```

2. `## 📖 Overview` — two to four paragraphs. For an internal Worker, the first one must say it
   is not exposed to the public internet directly, that the root gateway (`apps/api`) reaches it
   through a Cloudflare **service binding**, and what its public base URL therefore is. Then what
   it owns, and where the auth/public split falls.
3. `## ✨ Features` — a bulleted list, `- **Bold lead** — explanation`. One bullet per capability
   a reader would otherwise have to find in the source. Say *why* where the why is non-obvious;
   this is where the app's real decisions live.
4. `## 🛠 Tech Stack` — a two-column `| Layer | Technology |` table, linking each dependency to
   its own site.
5. `## 📋 Requirements` — only when the app needs something beyond `pnpm install` (a token, a
   Cloudflare account with a specific product, a first administrator).
6. `## 🚀 Getting Started` — numbered `###` steps with fenced `bash` blocks. Dependencies are
   always installed from the **monorepo root**. State the real `dev` port.
7. Middle sections — the app's own substance, freely titled with an emoji heading: an API/endpoint
   table, a content model, a sign-in flow, a worked example. This is where a big app earns its
   length; keep them ordered so a reader meets concepts before they are used.
8. `## ⚙️ Configuration` — a `| Variable | Purpose |` table drawn from `wrangler.jsonc` `vars` and
   `.dev.vars.example`, then a sentence listing the bindings. Never print a secret value.
9. `## 🌐 Deployment` — the `pnpm run deploy` block, the exact Worker `name` the gateway's service
   binding needs, and, for a stateful app, the note that migrations are applied by the repo's
   `Migrate` workflow on a push to `dev` with `pnpm run db:migrate:remote` as the manual fallback.
10. `## 📄 License` — `Licensed under **GPL-3.0-only** — see [LICENSE](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE).`
11. **Footer**

    ```markdown
    ---

    <div align="center">
    Made with ☕ by <a href="https://franciscosolis.cl">Fran</a>
    </div>
    ```

Separate every top-level section with a `---` rule on its own line.

## Voice

- English, always — the repo's language rule is absolute, whatever language the request came in.
- Third person about the app (`cms is what franciscosolis.cl is edited through`), never "we".
- Prose wrapped at about 100 columns. Tables and fenced blocks are exempt.
- Explain the decision, not just the behaviour. `Public routes only ever return published entries
  and 404 everything else, so an unfinished draft is not even discoverable` is the register.
- Backtick every identifier, path, route, header, column and command.
- Emoji appear in headings and nowhere else.
- Link a sibling app by its README, relative: ``[`apps/auth`](../auth/README.md)``, and a package
  the same way: ``[`@franciscosolis/emails`](../../packages/emails/README.md)``.
- No badges beyond the licence one, no table of contents, no "Roadmap", no "Status" theatre.

## Route tables

When an app has more than a handful of routes, group them under `###` subheadings by audience
(`Public`, then `Editorial (Bearer token required)`, then `Admin (permission-gated)`), one table
each, `| Method | Route | Description |` or the app's existing shape. Close the section by
pointing at the live document: the full, always-current description is the OpenAPI spec at
`https://api.franciscosolis.cl/openapi.json`.

## After writing

- `grep` the finished file for every command, port, route and variable you printed, and confirm
  each one against the file it came from.
- Check the links resolve: relative paths between apps, and the `dev` branch on GitHub links.
- A README change is a change to the app, so the version-bump hook will bump it. Let it.
- Leave `CLAUDE.md` alone — it is instructions for an agent, the README is documentation for a
  human, and they deliberately say different things.

`references/template.md` is this layout as a fill-in skeleton.
