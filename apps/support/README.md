<div align="center">

# 🛟 support — Support tickets and help centre

**Internal Cloudflare Worker behind `api.franciscosolis.cl/support`: support tickets people can open from the web or by email, and a bilingual help centre with lexical and semantic search over it.**

[![License](https://img.shields.io/badge/license-GPL--3.0--only-blue)](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE)

</div>

---

## 📖 Overview

`support` is how somebody asks **franciscosolis.cl** for help and how the team answers. It is not
exposed to the public internet directly: the root gateway Worker (`apps/api`) reaches it through a
Cloudflare **service binding** and proxies `/support/*`, so its public base URL is
`https://api.franciscosolis.cl/support`. The website renders the public half at
`franciscosolis.cl/help` and `franciscosolis.cl/tickets/<reference>`, and the team works the queue at
`franciscosolis.cl/support`.

A ticket can start in a browser or in a mailbox. Writing to `soporte@franciscosolis.cl` or
`support@franciscosolis.cl` opens one; replying to any message about it adds to the same thread; and
everything that can be done in the console — replies, internal notes only the team sees, labels,
assignment, watchers, a rewritten subject — sits beside that conversation rather than in place of it.
When the team answers and the person does not come back within thirty minutes, they get one email
covering every reply since the last one they were told about.

Beside the tickets is a help centre: bilingual articles, a public search box built on SQLite's FTS5,
and an assistant that drafts an agent's reply out of the published articles using Workers AI.

Opening a ticket is **public** — somebody who cannot sign in is exactly the person most likely to
need support. Reading one needs either the secret in the emailed link or an access token from
[`apps/auth`](../auth/README.md) whose verified email is on the ticket. Everything under `/admin`
needs a token minted for the `franciscosolis-support` application, on an allowed email domain, and
carrying the `support:agent` permission.

Unlike its siblings, this Worker has **three entry points and the gateway fronts only one of them**:
`fetch` is proxied, while `email` is dispatched to the script by Cloudflare Email Routing and
`scheduled` by a cron trigger.

---

## ✨ Features

- **One conversation, two doors** — the same thread is readable and writable from the browser and
  from a mailbox. An inbound reply is matched to its ticket by a routing key in the envelope address
  first, then by `In-Reply-To` against mail this Worker actually sent, then by an `[FS-1042]` tag in
  the subject — and that last rung is honoured **only** when the sender is already on the ticket,
  because unconditionally it is a one-line forgery that injects a message into a stranger's thread.
- **A notice only when nobody came back** — an agent's public reply schedules an email for thirty
  minutes' time; the person reading the thread in a browser cancels it by replying. A second agent
  reply inside the window does not push the deadline out, it just makes the digest longer.
- **Triage by model, never delivery by model** — an inbound email becomes a ticket from its raw
  headers, and Workers AI improves the subject, the language and the priority afterwards. A model
  outage costs a plainer subject line; it cannot cost an email.
- **Two kinds of search** — FTS5 over one row per article and language for the public search box,
  with accent-insensitive matching and `<mark>`-highlighted snippets; embeddings in Vectorize for the
  assistant. Unpublishing an article removes it from both.
- **The model drafts, a human sends** — `POST /admin/assist` answers only from retrieved articles,
  re-reads every one of them from D1 before building the prompt so a stale vector can never surface
  an unpublished draft, and intersects the model's citations with what was actually retrieved. With
  no surviving sources it returns without calling the text model at all.
- **Bilingual by override, not by row** — a help article's own columns hold English and a
  `translations` blob holds the Spanish, exactly as in [`apps/cms`](../cms/README.md). A public read
  takes `?locale` and reports which language it actually served.
- **Nothing about a ticket is HTML** — inbound mail is converted to text at ingest and the quoted
  trail is trimmed off, with the untouched original kept beside it. There is no column for markup
  anywhere on a ticket, which is what makes it structurally impossible for a later change to render
  the most thoroughly unauthenticated input this monorepo stores.
- **A refused lookup is a 404, never a 403** — ticket numbers are short and sequential, so a 403
  would enumerate every support request ever filed. `POST /tickets/resend-link` always answers `202`
  for the same reason.

---

## 🛠 Tech Stack

| Layer | Technology |
| --- | --- |
| Runtime | [Cloudflare Workers](https://developers.cloudflare.com/workers/) |
| HTTP | [Hono](https://hono.dev) |
| Schemas & docs | [valibot](https://valibot.dev) + [hono-openapi](https://github.com/rhinobase/hono-openapi) |
| Database | [Cloudflare D1](https://developers.cloudflare.com/d1/) via [Drizzle ORM](https://orm.drizzle.team) |
| Search | [SQLite FTS5](https://www.sqlite.org/fts5.html) + [Vectorize](https://developers.cloudflare.com/vectorize/) |
| Models | [Workers AI](https://developers.cloudflare.com/workers-ai/) |
| Mail out | [Cloudflare Email Sending](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/) + [`@franciscosolis/emails`](../../packages/emails/README.md) |
| Mail in | [Email Routing](https://developers.cloudflare.com/email-routing/email-workers/) + [postal-mime](https://github.com/postalsys/postal-mime) |
| Tooling | [Wrangler](https://developers.cloudflare.com/workers/wrangler/) + [Vitest](https://vitest.dev) |

---

## 📋 Requirements

Beyond a `pnpm install` at the monorepo root, this Worker needs three things that live in the
Cloudflare account rather than in this repository:

- A **D1 database** named `franciscosolis_support`, whose id is already in `wrangler.jsonc`.
- A **Vectorize index** — see [Deployment](#-deployment).
- **Email Routing rules** delivering `soporte@` and `support@` to this Worker, a **catch-all** rule
  so the `reply+<key>@` address every outgoing ticket email sets as its `Reply-To` is accepted, and
  `soporte@mail.franciscosolis.cl` verified for Email Sending.

---

## 🚀 Getting Started

### 1. Install dependencies

Always from the monorepo root — the workspace and its dependency catalog are shared.

```bash
pnpm install
```

### 2. Point it at a local auth Worker

```bash
cp apps/support/.dev.vars.example apps/support/.dev.vars
```

There are no secrets to fill in. The file only overrides `AUTH_ISSUER` and the public ticket URL so
a local support Worker trusts a local auth Worker and emails clickable links.

### 3. Apply the migrations and run it

```bash
cd apps/support
pnpm run db:migrate:local
pnpm run dev
```

It answers on `http://localhost:8793`, and through the gateway on
`http://localhost:8787/support` when `apps/api` is running too.

Workers AI and Vectorize have no local simulation, so `POST /admin/assist` and the vector half of an
article save reach the real services and need credentials. Everything else works offline.

---

## 📡 API

### Public

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/` | Service status and the vocabularies a front-end builds its filters from |
| `GET` | `/help/categories` | Published help-centre sections, `?locale` |
| `GET` | `/help/categories/:slug` | One section and the articles in it |
| `GET` | `/help/articles` | Published articles, filterable by section and by whether they are pinned |
| `GET` | `/help/articles/:slug` | One published article |
| `GET` | `/help/search` | Full-text search, with `<mark>`-highlighted snippets |
| `POST` | `/help/articles/:slug/feedback` | Whether an article answered the question |
| `POST` | `/tickets` | Open a ticket |
| `POST` | `/tickets/resend-link` | Email a fresh link. Always `202` |

### Ticket-scoped (the emailed link, or a session whose verified email is on the ticket)

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/tickets/:reference` | The ticket |
| `GET` | `/tickets/:reference/timeline` | The conversation. Never includes an internal note |
| `POST` | `/tickets/:reference/messages` | Reply, cancelling any deferred notice owed to the author |

### Signed-in requester (Bearer token, any accepted audience)

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/me/tickets` | Tickets belonging to this account |
| `POST` | `/me/tickets/claim` | Link tickets opened anonymously with this verified email |

### Support team (Bearer token, allowed domain, `support:agent`)

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/admin/me` | Who is signed in and what they may do |
| `GET` | `/admin/tickets` | The inbox, filterable by status, priority, assignee, label and text |
| `GET` `PATCH` `DELETE` | `/admin/tickets/:id` | One ticket; edit its subject, status, priority or language |
| `GET` | `/admin/tickets/:id/timeline` | The whole thread, internal notes included |
| `POST` | `/admin/tickets/:id/messages` | Post a `reply` or a `note` |
| `PUT` | `/admin/tickets/:id/assignee` | Assign, or clear with a null email |
| `POST` `PATCH` `DELETE` | `/admin/tickets/:id/participants[/:participantId]` | Watchers, and their internal-only `guest` / `interest` tag |
| `POST` `DELETE` | `/admin/tickets/:id/labels/:labelId` | Labels |
| `GET` `POST` | `/admin/labels` | The label catalogue |
| `PATCH` `DELETE` | `/admin/labels/:id` | Update or delete a label |
| `GET` | `/admin/emails` | Outgoing mail, sent and failed |
| `GET` | `/admin/notifications` | The deferred-reply queue |
| `GET` | `/admin/audit` | The audit trail |

### Support administrator (additionally `support:admin`)

| Method | Route | Description |
| --- | --- | --- |
| `GET` `POST` | `/admin/help/categories` | Help-centre sections |
| `PATCH` `DELETE` | `/admin/help/categories/:id` | Update or delete a section |
| `GET` `POST` | `/admin/help/articles` | Articles |
| `GET` `PATCH` `DELETE` | `/admin/help/articles/:id` | One article |
| `POST` | `/admin/help/articles/:id/reindex` | Rebuild both search indexes for it |
| `POST` | `/admin/assist` | Draft an answer from the help centre |

The always-current description is the OpenAPI document at
`https://api.franciscosolis.cl/openapi.json`, which merges this Worker's own spec under `/support`.

---

## 🧱 The ticket model

| Concept | What it is |
| --- | --- |
| Reference | `FS-1042`. Short enough to read out loud, allocated from a counter row rather than `max() + 1` |
| Status | `new`, `open`, `pending`, `on_hold`, `solved`, `closed`, `spam` |
| Message | A `reply` everybody on the ticket sees, or a `note` that never leaves the team |
| Participant | The requester, anybody on copy, and the agents who picked it up. An agent can tag one `guest` or `interest`, which the requester's own view never sees |
| Access token | A 256-bit secret in the fragment of the emailed link. Stored only as a SHA-256 |
| Reply key | A separate 128-bit lowercase-hex key in the `reply+<key>@` address, never rotated |
| Deferred notice | One pending row per person per ticket, due thirty minutes after an agent reply |

The two secrets are deliberately different columns: the access token is a credential and must be
rotatable the day a link is forwarded to the wrong person, while the reply key is routing metadata
baked into an address that sits in every participant's mail client forever.

---

## ⚙️ Configuration

| Variable | Purpose |
| --- | --- |
| `AUTH_JWKS_URL` | Path the auth Worker's key set is read from, over the `AUTH` binding |
| `AUTH_ISSUER` | Expected `iss` claim. Must match `apps/auth` exactly |
| `SUPPORT_ALLOWED_AUDIENCES` | Client ids that may act as an agent. Gates `/admin` |
| `SUPPORT_REQUESTER_AUDIENCES` | Wider list a requester may present to read their own ticket |
| `SUPPORT_ALLOWED_EMAIL_DOMAINS` | Email domains allowed into the console |
| `SUPPORT_INBOX_ADDRESSES` | Addresses Email Routing delivers here |
| `SUPPORT_REPLY_DOMAIN` | Domain the `reply+<key>@` address lives on |
| `SUPPORT_TICKET_URL` | Base of the public ticket link |
| `MAIL_FROM_EMAIL` / `MAIL_FROM_NAME` | Sender of every outgoing message |
| `MAIL_REPLY_TO` | Where a reply goes — the receiving domain, not the sending one |
| `AI_TEXT_MODEL` / `AI_EMBEDDING_MODEL` | Workers AI models, as vars so a retirement is a deploy |

Bindings: `DB` (D1 `franciscosolis_support`), `AUTH` (service binding, read for its JWKS only),
`EMAIL` (Email Sending), `AI` (Workers AI) and `VECTORIZE` (`franciscosolis-support-help`). This
Worker holds **no secrets**.

The two audience lists are separate on purpose and must stay that way: merging them would leave the
domain and permission checks as the only thing keeping a token minted for the public website out of
the support console.

---

## 🌐 Deployment

```bash
cd apps/support
pnpm run deploy
```

The Worker must be deployed under the exact name `support` for the gateway's `SUPPORT` service
binding to resolve. It needs no route or custom domain of its own.

Migrations are applied by the repository's `Migrate` workflow on a push to `dev` that touches
`apps/*/migrations/**`; `pnpm run db:migrate:remote` is the manual fallback.

Before the first deploy, create the vector index — it is not configured from this repository:

```bash
wrangler vectorize create franciscosolis-support-help --dimensions=1024 --metric=cosine
wrangler vectorize create-metadata-index franciscosolis-support-help --property-name=locale --type=string
```

The metadata index is the one that fails quietly: without it a `locale` filter returns nothing rather
than erroring, and the assistant degrades to "no sources found" with no signal anywhere.

Email Routing rules are dashboard configuration in the same way Workers Builds is, and are listed
under *Operator setup* in [`CLAUDE.md`](CLAUDE.md). The cron trigger ships with the deploy, but fires
only on the production deployment — never on a preview — so the deferred digest cannot be exercised
from a preview URL.

---

## 📄 License

Licensed under **GPL-3.0-only** — see [LICENSE](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE).

---

<div align="center">
Made with ☕ by <a href="https://franciscosolis.cl">Fran</a>
</div>
