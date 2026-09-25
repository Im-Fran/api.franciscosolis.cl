<div align="center">

# 🔔 notifications — In-site notifications, Web Push and digests

**Internal Cloudflare Worker behind `api.franciscosolis.cl/notifications`: the notification inbox on franciscosolis.cl, Web Push to the devices people register, and the daily or weekly email that replaces one email per event.**

[![License](https://img.shields.io/badge/license-GPL--3.0--only-blue)](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE)

</div>

---

## 📖 Overview

`notifications` exists to send **less email**. Before it, every sign-in, every authorization and every
piece of news was its own message. Now the other Workers publish an event, this Worker files it in
the person's inbox on the website, pushes it to any device they registered, and emails it only as
often as they asked: immediately, in a **daily digest at 09:00 Santiago time**, in a **weekly digest on
Mondays**, or never. The default is daily.

It is not exposed to the public internet directly: the gateway (`apps/api`) reaches it through the
`NOTIFICATIONS` service binding and proxies `/notifications/*`, so its public base URL is
`https://api.franciscosolis.cl/notifications`. The website shows the bell in its header and a
**Notifications** tab at `franciscosolis.cl/account/notifications`.

Events arrive on a **Cloudflare Queue**, not over HTTP — see [How events arrive](#-how-events-arrive).

---

## ✨ Features

- **An inbox per account** — newest first, keyset-paginated, filterable by unread and by category,
  with read/unread, mark-all-read and delete. Kept indefinitely; deleting is up to the person.
- **Rendered on read, in either language** — a row stores a type and its parameters, and the title
  and body are written from a catalog in English or Spanish when they are read, emailed or pushed.
- **Web Push** — VAPID (RFC 8292) and `aes128gcm` payload encryption (RFC 8291), implemented on
  WebCrypto with no dependency. Dead subscriptions are dropped as push services report them.
- **Preferences** — push and email per category (`account`, `support`, `marketplace`) plus one email
  frequency. In-site notifications have no switch: they are the record.
- **Digests** — one email listing what the person has not already read on the site, sent only if
  there is something to list.
- **No duplicate mail** — receipts, refunds and support replies are still emailed by the Worker that
  owns them, so for those this one keeps the in-site copy and the push and never emails them again.

---

## 🛠 Tech Stack

| Layer | Technology |
| --- | --- |
| Runtime | [Cloudflare Workers](https://developers.cloudflare.com/workers/) |
| HTTP | [Hono](https://hono.dev) |
| Schemas & docs | [valibot](https://valibot.dev) + [hono-openapi](https://github.com/rhinobase/hono-openapi) |
| Database | [Cloudflare D1](https://developers.cloudflare.com/d1/) via [Drizzle ORM](https://orm.drizzle.team) |
| Events in | [Cloudflare Queues](https://developers.cloudflare.com/queues/) |
| Push | [Web Push](https://www.rfc-editor.org/rfc/rfc8030) with VAPID, on WebCrypto |
| Mail out | [Cloudflare Email Sending](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/) + [`@franciscosolis/emails`](../../packages/emails/README.md) |
| Tooling | [Wrangler](https://developers.cloudflare.com/workers/wrangler/) + [Vitest](https://vitest.dev) |

---

## 📋 Requirements

Beyond a `pnpm install` at the monorepo root, this Worker needs four things that live in the
Cloudflare account rather than in this repository — twice, once per environment:

- A **D1 database**: `franciscosolis_notifications` (and `franciscosolis_notifications_dev`). Both
  exist and their ids are in `wrangler.jsonc`; recreating one means replacing its id there.
- A **queue**: `franciscosolis-notifications` (and `franciscosolis-notifications-dev`).
- The **`VAPID_PRIVATE_KEY` secret** — see [Deployment](#-deployment). Without it everything works but push.
- `hola@mail.franciscosolis.cl` verified for Email Sending, which `apps/auth` already needs.

---

## 🚀 Getting Started

```bash
pnpm install                                   # from the monorepo root
cp apps/notifications/.dev.vars.example apps/notifications/.dev.vars
cd apps/notifications
pnpm run db:migrate:local
pnpm run dev
```

It answers on `http://localhost:8795`, and through the gateway on
`http://localhost:8787/notifications` when `apps/api` is running too.

---

## 📡 API

### Public

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Categories, email frequencies, the digest clock and the VAPID public key (`null` when push is off) |
| `GET` | `/openapi.json` | This Worker's OpenAPI document |

### Signed in (Bearer token minted for `franciscosolis-web`)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/me/notifications` | `?locale`, `?limit`, `?cursor`, `?filter=unread`, `?category` — a page, `next_cursor` and the unread count |
| `GET` | `/me/notifications/unread-count` | What the bell polls |
| `POST` | `/me/notifications/:id/read` · `/unread` | Mark one |
| `POST` | `/me/notifications/read-all` | Every unread one, or every one in `{ category }` |
| `DELETE` | `/me/notifications/:id` | Delete one for good |
| `GET` / `PUT` | `/me/preferences` | Email frequency, push/email per category, language. `PUT` is partial |
| `GET` / `POST` | `/me/push-subscriptions` | List devices; register this browser's `PushSubscription` |
| `DELETE` | `/me/push-subscriptions/:id` | Stop pushing to one device |
| `POST` | `/me/push-subscriptions/test` | Push a test notice to every device |

Everything is scoped to the token's `sub`; another account's notification answers 404, the same as a
missing one.

---

## 📨 How events arrive

`apps/auth`, `apps/support` and `apps/marketplace` put a `NotificationEvent` on the queue and carry
on. This Worker is the queue's consumer:

```ts
{ version: 1, id: '<uuid>', type: 'account.sign_in', user: { id, email?, name?, locale? },
  occurred_at: '<ISO 8601>', data: { …flat parameters… }, url: '/account/sessions' }
```

| Type | From | Emailed by this Worker |
| --- | --- | --- |
| `account.sign_in`, `account.authorization` | auth | yes — immediate uses the detailed account-access template |
| `account.avatar_approved`, `account.avatar_rejected` | auth | yes |
| `support.ticket_reply`, `support.participant_added` | support | no — support emails them itself |
| `marketplace.purchase_completed`, `marketplace.purchase_refunded` | marketplace | no — the receipt and refund notice |
| `marketplace.release_published`, `marketplace.review_reply` | marketplace | yes |

The event id is the notification's primary key, so a redelivery inserts nothing and pushes nothing.
A malformed event is acknowledged and dropped; an unknown type is retried, since it means a producer
was deployed ahead of this Worker.

---

## ⚙️ Configuration

| Variable | Purpose |
| --- | --- |
| `AUTH_JWKS_URL` | Path the auth Worker's key set is read from, over the `AUTH` binding |
| `AUTH_ISSUER` | Expected `iss` claim. Must match `apps/auth` exactly |
| `NOTIFICATIONS_ALLOWED_AUDIENCES` | Client ids whose tokens may read an inbox — the website only |
| `SITE_URL` | Origin every notification path is resolved against, in email and push |
| `VAPID_SUBJECT` | Contact the push services see, as `mailto:` |
| `MAIL_FROM_EMAIL` / `MAIL_FROM_NAME` | Sender of every email |
| `VAPID_PRIVATE_KEY` | **Secret.** P-256 private JWK; the public key is derived from it |

Bindings: `DB` (D1), `AUTH` (service binding, read for its JWKS only), `EMAIL` (Email Sending), the
queue consumer, and an hourly cron.

---

## 🌐 Deployment

```bash
wrangler d1 create franciscosolis_notifications          # and _dev; ids into wrangler.jsonc
wrangler queues create franciscosolis-notifications      # and -dev
node apps/notifications/scripts/generate-vapid-keys.mjs | npx wrangler secret put VAPID_PRIVATE_KEY
node apps/notifications/scripts/generate-vapid-keys.mjs | npx wrangler secret put VAPID_PRIVATE_KEY --env dev
cd apps/notifications && pnpm run deploy
```

Generate a **separate** key per environment: a browser subscription is bound to the public key it
was created with, so a dev subscription can never be pushed to from production. Rotating a key
orphans every subscription; the website re-subscribes on the next visit.

The Worker must be deployed as `notifications` for the gateway's binding to resolve, and **after**
`auth`, because it binds it. The queue must exist before `auth`, `support` and `marketplace` deploy,
since they bind it as producers — a queue is not a Worker, so it adds no cycle to the deploy order.
The cron fires only on the production deployment, never on a preview.

---

## 📄 License

Licensed under **GPL-3.0-only** — see [LICENSE](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE).

---

<div align="center">
Made with ☕ by <a href="https://franciscosolis.cl">Fran</a>
</div>
