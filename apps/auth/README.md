<div align="center">

# 🔐 auth — Centralized Authentication

**Internal Cloudflare Worker behind `api.franciscosolis.cl/auth`: a complete OAuth 2.0 + OpenID Connect provider — authorization code with PKCE, rotatable client secrets, magic link and Google sign-in, roles and permissions on D1.**

[![License](https://img.shields.io/badge/license-GPL--3.0--only-blue)](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE)

</div>

---

## 📖 Overview

`auth` is the identity service for **franciscosolis.cl** and any other application registered
against it. It is not exposed to the public internet directly: the root gateway Worker
(`apps/api`) reaches it through a Cloudflare **service binding** and proxies `/auth/*`, so its
public base URL is `https://api.franciscosolis.cl/auth`.

Sign-in is a standard **OAuth 2.0 authorization code flow with PKCE**, so the client application
never sees tokens in a URL. Two providers can prove who the user is — a **magic link** delivered
with Cloudflare Email Sending, and **Google OAuth 2.0** — and both converge on the same code path
afterwards. The result is an **EdDSA-signed JWT access token** that any Worker or backend can
verify offline against `/.well-known/jwks.json`, plus a rotating refresh token stored in D1.

It is also a full **OpenID Connect provider**: one authorization endpoint, an `id_token`, a
UserInfo endpoint and a discovery document, which is what lets an off-the-shelf relying party —
another application of ours on its own domain, or **Cloudflare Access** — point at it and work
without anything being written for it specially. Confidential clients authenticate with a
**client secret** that can be rotated with a grace period, so a rotation never means downtime.

Accounts, identities, applications, roles, permissions, invitations, sessions and an audit trail
all live in the `franciscosolis_auth` D1 database, accessed through **Drizzle ORM**.

---

## ✨ Features

- **One authorization endpoint** — `GET /oauth/authorize` validates and parks the request, then
  hands the browser to the sign-in front-end with the parked handle; whichever provider the user
  chooses there resumes that same request. This Worker is an API and renders no pages of its own:
  `AUTH_LOGIN_URL` names the front-end, and it defaults to
  [`https://franciscosolis.cl/apps/auth`](https://franciscosolis.cl/apps/auth).
- **OpenID Connect** — `id_token` with `nonce`, `at_hash`, `auth_time`, `sid` and `groups`, a
  UserInfo endpoint, token introspection, RP-initiated logout and a discovery document published
  at both `/.well-known/openid-configuration` and `/.well-known/oauth-authorization-server`.
- **Client secrets with overlapping rotation** — a confidential client can hold several secrets at
  once. Rotating issues a new one and gives the outgoing ones a deadline instead of cutting them
  off, so a deployment has a window to pick the new value up; `grace_seconds: 0` ends them at once,
  which is what a leak calls for. Only the SHA-256 hash is ever stored, and `last_used_at` says
  whether an old secret is still being presented by anything.
- **Per-client policy** — authentication method (`none`, `client_secret_post`,
  `client_secret_basic`), allowed grants, allowed scopes, post-logout redirect URIs, extra CORS
  origins, and whether PKCE is required. PKCE can only be waived for a confidential client.
- **Cross-domain by design** — the OAuth endpoints, the account endpoints and the admin API answer
  CORS from any origin a registered client actually uses, so an application on its own domain needs
  no gateway change to sign in or to administer this service. An allowed origin may be a
  `https://*.example.com` pattern, which is what lets a Cloudflare preview deployment — whose
  hostname only exists once it is deployed — call this service at all.
- **Client credentials grant** — for a backend acting as itself rather than for a person.
- **Authorization code + PKCE for every provider** — the browser only ever carries a one-time
  `code`; tokens are fetched with a separate `POST /oauth/token` bound to the client's
  `code_verifier`.
- **Pluggable providers** — a provider's only contract is producing a verified `ProviderProfile`.
  Account resolution, code issuance and the redirect back are shared, so adding a provider is a
  descriptor plus a routes file.
- **Magic link sign-in** — emailed from `FranciscoSolis <hola@mail.franciscosolis.cl>` through
  Cloudflare Email Sending. The link carries only an opaque token; the redirect target is stored
  server-side and cannot be rewritten by a mail client.
- **Templated email bodies** — the sign-in and invitation messages are
  [react-email](https://react.email) components in the shared
  [`@franciscosolis/emails`](../../packages/emails/README.md) package, so interpolated values are
  escaped by construction, the plain-text alternative is derived from the HTML instead of
  maintained beside it, and both can be previewed in a browser without sending anything.
- **Google OAuth 2.0** — PKCE and `nonce` on the Google leg too, with the ID token verified
  against Google's JWKS rather than trusted from the transport.
- **Offline token verification** — EdDSA (Ed25519) keys published at `/.well-known/jwks.json`,
  with `kid`-based selection and a retired-key list so rotation does not invalidate live tokens.
- **Rotating refresh tokens with reuse detection** — every exchange issues a new token; replaying
  a spent one revokes the entire session.
- **Immediate revocation** — roles, account status and session validity are re-read from D1 on
  every authenticated request, so disabling a user or signing out takes effect at once instead of
  at token expiry.
- **Roles and permissions** — global or per-application roles, each a bag of permissions; route
  guards check permission slugs, never role names.
- **Invitation-only sign-up** — an unknown address cannot create an account without a pending
  invitation, and the endpoint answers identically either way so it cannot be used to enumerate
  accounts.
- **Audit trail** — every sign-in, token issuance, revocation and admin action is appended to
  `audit_logs`.
- **Auto-generated OpenAPI** — every route is described with `describeRoute` + valibot, published
  at `/openapi.json` and merged into the gateway's combined document under `/auth/*`.

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers (`nodejs_compat`) |
| Framework | [Hono](https://hono.dev) 4 |
| Database | Cloudflare D1 (`franciscosolis_auth`) via [Drizzle ORM](https://orm.drizzle.team) |
| Email | [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/) (`send_email` binding) |
| Email templates | [react-email](https://react.email) via `@franciscosolis/emails` |
| Validation / OpenAPI | [valibot](https://valibot.dev) + [hono-openapi](https://www.npmjs.com/package/hono-openapi) |
| Tokens | JWT, EdDSA (Ed25519) via WebCrypto |
| HTTP client | axios |
| Tooling | Wrangler 4, drizzle-kit, TypeScript (ESNext, strict) |

---

## 🚀 Getting Started

Dependencies are installed from the **monorepo root**.

```bash
pnpm install
```

### 1. Configure secrets

```bash
cp apps/auth/.dev.vars.example apps/auth/.dev.vars
cd apps/auth && pnpm run keys:generate
```

Paste the printed **private** JWK into `.dev.vars` as `JWT_PRIVATE_KEY`, then fill in your Google
OAuth client.

| Variable | Where | Description |
|----------|-------|-------------|
| `JWT_PRIVATE_KEY` | secret | Ed25519 private key (JWK JSON) used to sign access tokens |
| `JWT_RETIRED_PUBLIC_KEYS` | secret, optional | JSON array of retired public JWKs still published in the JWKS |
| `GOOGLE_CLIENT_ID` | secret | Google OAuth 2.0 client id |
| `GOOGLE_CLIENT_SECRET` | secret | Google OAuth 2.0 client secret |
| `AUTH_PUBLIC_URL` | `wrangler.jsonc` var | Public base URL, e.g. `https://api.franciscosolis.cl/auth` |
| `AUTH_ISSUER` | `wrangler.jsonc` var | `iss` claim of issued access tokens |
| `MAIL_FROM_EMAIL` / `MAIL_FROM_NAME` | `wrangler.jsonc` var | Sender identity for outgoing email |

In production, set the secrets with Wrangler:

```bash
cd apps/auth
pnpm exec wrangler secret put JWT_PRIVATE_KEY
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
```

### 2. Set up the database

```bash
cd apps/auth
pnpm run db:migrate:local    # local dev database
pnpm run db:migrate:remote   # the real franciscosolis_auth D1 database
```

The seed migration creates the baseline permissions, the global `admin` and `user` roles, and the
`franciscosolis-web` client application (redirect URIs `https://franciscosolis.cl/auth/callback`
and `http://localhost:5173/auth/callback`).

### 3. Create the first administrator

Sign-up is invitation-only and nothing in the environment bypasses that, so the first account is
seeded straight into the database:

```bash
cd apps/auth
pnpm run admin:bootstrap             # local dev database
pnpm run admin:bootstrap -- --remote  # the real franciscosolis_auth D1 database
```

The script asks for an email address and writes a pending, global invitation carrying the `admin`
role, valid for 7 days: the next magic link sent to that address creates the account and grants it
`admin`. If the address already has an account, the role is granted to it directly. Re-running it
replaces the pending invitation instead of piling up duplicates. Every further account is invited
from the admin API (`POST /auth/admin/invitations`).

### 4. Configure Google

In the Google Cloud console, add this exact authorized redirect URI:

```
https://api.franciscosolis.cl/auth/oauth/google/callback
```

For local development, `.dev.vars` overrides `AUTH_PUBLIC_URL`, so also add the matching
`http://localhost:8787/auth/oauth/google/callback`.

### 5. Configure email

Onboard `mail.franciscosolis.cl` in **Compute → Email Service → Email Sending** in the Cloudflare
dashboard so `hola@mail.franciscosolis.cl` is allowed to send.

The bodies themselves come from the shared
[`@franciscosolis/emails`](../../packages/emails/README.md) package. To look at them without
sending anything:

```bash
pnpm --filter @franciscosolis/emails run preview   # http://localhost:8791
```

### 6. Run

```bash
pnpm run dev            # from the repo root, runs every Worker in parallel
```

`auth` listens on `http://localhost:8789` (inspector `9231`), and is reachable through the gateway
at `http://localhost:8787/auth/*`.

---

## 🧩 Client applications

Every sign-in starts from a registered client application: its `client_id` is what
`/oauth/authorize` is called with, and its redirect URIs are compared by exact string match. The
migrations register `franciscosolis-web` and `franciscosolis-cms`; everything else is registered
either through the admin API or from the CLI, which writes straight to D1 and so needs no access
token — which is what makes it usable before anyone can sign in.

```bash
cd apps/auth
pnpm run applications -- list             # local dev database
pnpm run applications -- list --remote    # the real franciscosolis_auth database
```

| Command | What it does |
|---------|--------------|
| `list` | Every registered client, with its type, status and redirect URI count |
| `show <client-id>` | One client in full, with the metadata of its secrets |
| `create [<client-id>]` | Registers a client; prompts for whatever is not passed as a flag |
| `update <client-id>` | Name, description, redirect URIs, policy or active status |
| `rotate-secret <client-id>` | Issues a new secret and retires the previous ones after a grace period |
| `revoke-secret <client-id>` | Revokes one secret by id |
| `delete <client-id>` | Removes a client and everything keyed to it |

```bash
# A browser app: public client, PKCE only.
pnpm run applications -- create franciscosolis-web \
  --name "franciscosolis.cl" \
  --redirect-uri https://franciscosolis.cl/auth/callback \
  --redirect-uri http://localhost:5173/auth/callback

# A backend that can keep a secret.
pnpm run applications -- create my-backend --name "My backend" \
  --redirect-uri https://my-backend.test/auth/callback --confidential

# A machine-to-machine client, with no user behind it.
pnpm run applications -- create my-worker --name "My worker" \
  --redirect-uri https://my-worker.test/unused --confidential \
  --grant-type client_credentials

# Add a redirect URI without restating the existing ones.
pnpm run applications -- update franciscosolis-cms --add-redirect-uri http://localhost:5174/auth/callback

# Stop new sign-ins; tokens already issued keep working until they expire.
pnpm run applications -- update my-backend --deactivate --remote
```

### Rotating a secret

```bash
# Routine rotation: the current secret keeps working for a week while the new one rolls out.
pnpm run applications -- rotate-secret my-backend --remote

# One day instead.
pnpm run applications -- rotate-secret my-backend --grace 86400 --remote

# A leak: the old secret stops authenticating immediately.
pnpm run applications -- rotate-secret my-backend --grace 0 --remote

# Which secrets exist, and whether the old one is still being used by anything.
pnpm run applications -- show my-backend --remote
```

A client secret is printed **once**, at creation and on rotation — only its SHA-256 hash is stored,
exactly as with the admin API, so it cannot be read back afterwards. `show` lists a six-character
hint and `last_used_at` per secret, which is how you tell whether it is safe to revoke one early.
Add `--json` for scriptable output, `--dry-run` to see the SQL without running it, and `-y` to skip
confirmations. Every write lands in `audit_logs` tagged `{"source":"cli"}`.

The same is available over HTTP for anyone holding `applications:write`:
`GET`/`POST /admin/applications/:id/secrets` and
`DELETE /admin/applications/:id/secrets/:secretId`.

---

## 🔑 Sign-in flow

The general entry point is one endpoint. It parks the request, lets the user pick a provider, and
whichever one they choose ends on the same one-time `code` at the client's redirect URI.

```
1. Client generates code_verifier + code_challenge (S256), a state and a nonce.

2. GET /auth/oauth/authorize
     ?response_type=code&client_id&redirect_uri&scope=openid%20profile%20email
      &state&nonce&code_challenge&code_challenge_method=S256
   → 302 to AUTH_LOGIN_URL?request=<handle>  (the sign-in front-end)

3a. Magic link                              3b. Google
    POST /auth/oauth/authorize/<handle>         GET /auth/oauth/authorize/<handle>/google
         /magic-link  { email }                 → 302 to Google, user approves
    → link emailed, user clicks it              GET /auth/oauth/google/callback?code&state
    GET /auth/magic-link/callback?token=…

4. → 302 <redirect_uri>?code=…&state=…

5. POST /auth/oauth/token   (application/x-www-form-urlencoded)
     grant_type=authorization_code
     client_id, code, redirect_uri, code_verifier
     (+ client_secret, or an HTTP Basic header, for a confidential client)
   → { access_token, token_type, expires_in, refresh_token, id_token, scope, session_id }

6. Authenticated requests: Authorization: Bearer <access_token>
   Claims:   GET /auth/oauth/userinfo
   Refresh:  grant_type=refresh_token&client_id=…&refresh_token=…
   Sign out: GET /auth/oauth/logout?id_token_hint=…&post_logout_redirect_uri=…
```

`id_token` is issued whenever the granted scope contains `openid`. A client that wants to skip the
provider chooser can pass `provider=google`, or keep calling `POST /auth/magic-link` and
`GET /auth/oauth/google/authorize` directly — both still take the same parameters and still work.

Access tokens and ID tokens live 15 minutes, refresh tokens 30 days and rotate on every use.
Authorization codes live 2 minutes, magic links 15 minutes, a parked authorization request 30.

---

## 🌍 Another application, on another domain

Nothing about the gateway has to change to sign in from a different domain. Register the client
with its redirect URI, and the OAuth endpoints will answer cross-origin requests from that origin —
the allowlist is the set of origins registered clients actually use, not a list kept in the
gateway's source (see `ownsCors` in `apps/api/src/services.ts`).

```bash
pnpm run applications -- create my-app --name "My app" \
  --redirect-uri https://my-app.example/auth/callback --remote
# → the browser at https://my-app.example may now call /auth/oauth/token and /auth/oauth/userinfo
```

Add `--allowed-origin https://console.my-app.example` for an origin that has no redirect URI of its
own, such as a dashboard calling the API from a different subdomain.

### Preview deployments

An `--allowed-origin` may start with a `*.` label, meaning any subdomain of the host it is anchored
on:

```bash
pnpm run applications -- update my-app \
  --allowed-origin 'https://*.previews.my-app.example' --remote
```

That is there for Cloudflare previews. A Worker deployed from a branch or a version is served at
`<alias>-<worker>.<account>.workers.dev`, a hostname that does not exist until the deployment does,
so it cannot be registered in advance — and without it the preview's first preflight is refused and
sign-in never starts. Both seeded clients already carry
`https://*.franciscosolis.workers.dev`, the account's own preview subdomain.

The wildcard replaces only the leftmost labels and is matched on a dot boundary, so
`evilfranciscosolis.workers.dev` is not a subdomain of `franciscosolis.workers.dev`. It applies to
**CORS only**: redirect URIs are still compared byte for byte, and a wildcard is refused there. A
preview that has to complete a sign-in — not just call the API — needs its own callback registered:

```bash
pnpm run applications -- update franciscosolis-web \
  --add-redirect-uri https://my-branch-franciscosolis.franciscosolis.workers.dev/auth/callback --remote
```

### Cloudflare Access as a relying party

Cloudflare Access speaks generic OIDC and does not implement PKCE, which is what
`--no-pkce` exists for. It is only sound because the client authenticates with a secret instead.

```bash
pnpm run applications -- create cloudflare-access --name "Cloudflare Access" \
  --redirect-uri https://<your-team>.cloudflareaccess.com/cdn-cgi/access/callback \
  --auth-method client_secret_post --no-pkce \
  --scope openid --scope email --scope profile --scope groups \
  --remote
```

Then, in the Cloudflare dashboard, add a generic OIDC identity provider with the printed
`client_id` and `client_secret` and these endpoints:

| Field | Value |
|-------|-------|
| Auth URL | `https://api.franciscosolis.cl/auth/oauth/authorize` |
| Token URL | `https://api.franciscosolis.cl/auth/oauth/token` |
| Certificate URL | `https://api.franciscosolis.cl/auth/.well-known/jwks.json` |
| Claims | `groups` (role slugs), `email`, `name` |

Group rules read the `groups` claim, which carries this service's role slugs, so an Access policy
can be written against a role granted here. Note that sign-up stays invitation-only: an address
Access sends over that has no account and no pending invitation is refused, deliberately.

---

## 📚 Endpoints

All paths are relative to `https://api.franciscosolis.cl/auth`.

### Discovery

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Service status and the available providers |
| `GET` | `/.well-known/jwks.json` | Public keys for offline access token verification |
| `GET` | `/.well-known/oauth-authorization-server` | RFC 8414 metadata |
| `GET` | `/.well-known/openid-configuration` | The same document, under its OpenID Connect name |
| `GET` | `/openapi.json` | OpenAPI 3 document |

### Sign-in

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/oauth/authorize` | The authorization endpoint: parks the request, redirects to the sign-in front-end |
| `GET` | `/oauth/authorize/:handle` | Describes a parked request, for the sign-in front-end |
| `POST` | `/oauth/authorize/:handle/magic-link` | Continue a parked request by email (JSON) |
| `GET` | `/oauth/authorize/:handle/google` | Continue a parked request through Google |
| `POST` | `/magic-link` | Request a magic link directly (always 202) |
| `GET` | `/magic-link/callback` | Consume the link, redirect with an authorization code |
| `GET` | `/oauth/google/authorize` | Start the Google flow directly |
| `GET` | `/oauth/google/callback` | Google's redirect target |
| `POST` | `/oauth/token` | Exchange a code, rotate a refresh token, or issue a client token |
| `POST` | `/oauth/revoke` | Revoke an access or refresh token, and the session behind it |
| `POST` | `/oauth/introspect` | RFC 7662 introspection of the calling client's own tokens |
| `GET` `POST` | `/oauth/userinfo` | OIDC claims about the bearer of an access token |
| `GET` `POST` | `/oauth/logout` | RP-initiated logout |

### Authenticated (`Authorization: Bearer …`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/me` | Profile, roles and permissions |
| `PATCH` | `/me` | Update the profile fields the user owns |
| `GET` | `/me/identities` | Linked providers |
| `GET` | `/me/sessions` | Active sessions |
| `DELETE` | `/me/sessions/:id` | Revoke one session |
| `POST` | `/logout` | Revoke the current session |

### Admin (permission-gated)

| Method | Path | Permission |
|--------|------|------------|
| `GET` | `/admin/users` | `users:read` |
| `GET` | `/admin/users/:id` | `users:read` |
| `PATCH` | `/admin/users/:id` | `users:write` |
| `POST` | `/admin/users/:id/roles` | `users:write` |
| `DELETE` | `/admin/users/:id/roles/:roleId` | `users:write` |
| `DELETE` | `/admin/users/:id/sessions` | `sessions:revoke` |
| `GET` `POST` | `/admin/invitations` | `invitations:read` / `invitations:write` |
| `DELETE` | `/admin/invitations/:id` | `invitations:write` |
| `GET` `POST` | `/admin/applications` | `applications:read` / `applications:write` |
| `PATCH` | `/admin/applications/:id` | `applications:write` |
| `GET` | `/admin/applications/:id/secrets` | `applications:read` |
| `POST` | `/admin/applications/:id/secrets` | `applications:write` |
| `DELETE` | `/admin/applications/:id/secrets/:secretId` | `applications:write` |
| `GET` `POST` | `/admin/roles` | `roles:read` / `roles:write` |
| `GET` | `/admin/permissions` | `roles:read` |
| `POST` | `/admin/roles/:id/permissions` | `roles:write` |
| `DELETE` | `/admin/roles/:id/permissions/:slug` | `roles:write` |

---

## 🗄 Database

`franciscosolis_auth` (D1), defined in `src/db/schema.ts`:

| Table | Purpose |
|-------|---------|
| `users` | One row per person, keyed by email |
| `identities` | Provider accounts linked to a user (`magic_link`, `google`) |
| `applications` | Registered OAuth clients: redirect URIs, authentication method, grants, scopes |
| `application_secrets` | Client secrets, hashed; several may be alive at once during a rotation |
| `authorization_requests` | Requests parked at `/oauth/authorize` while the user authenticates |
| `roles` / `permissions` / `role_permissions` / `user_roles` | Authorization model |
| `invitations` | Allowlist controlling who may sign up |
| `magic_link_tokens` | Pending magic links with their captured authorization request |
| `oauth_states` | In-flight redirects to an external provider |
| `authorization_codes` | One-time codes awaiting exchange |
| `sessions` / `refresh_tokens` | Sign-ins and their rotating token chains |
| `audit_logs` | Append-only trail of security-relevant events |

Every user-facing token is stored only as a SHA-256 hash.

To change the schema:

```bash
cd apps/auth
pnpm run db:generate          # writes migrations/NNNN_*.sql from src/db/schema.ts
pnpm run db:migrate:remote
```

---

## 🔍 Verifying a token from another service

No call to this Worker is needed at request time:

```ts
import { verifyWithJwks } from 'hono/jwt'

const claims = await verifyWithJwks(accessToken, {
  jwks_uri: 'https://api.franciscosolis.cl/auth/.well-known/jwks.json',
  allowedAlgorithms: ['EdDSA'],
  verification: { iss: 'https://api.franciscosolis.cl/auth', aud: 'your-client-id' },
})

// claims.sub, claims.email, claims.roles, claims.permissions, claims.sid
```

Claims are a 15-minute snapshot. For actions where a just-revoked role matters, call `/auth/me`
with the token instead — it re-reads roles and session state from the database.

---

## 🔐 Rotating the signing key

1. `pnpm run keys:generate`
2. Add the **old** public JWK to the `JWT_RETIRED_PUBLIC_KEYS` array secret.
3. Replace `JWT_PRIVATE_KEY` with the new private JWK.
4. After 15 minutes (the access token lifetime) no token is signed with the old key any more, and
   it can be dropped from `JWT_RETIRED_PUBLIC_KEYS`.

New tokens carry the new `kid`; old ones keep verifying against the retired key throughout.

---

## 🌐 Deployment

```bash
cd apps/auth && pnpm run deploy
```

The Worker must be deployed under the exact name `auth` for the gateway's `AUTH` service binding
to resolve. It needs no route or custom domain of its own.

---

## 📄 License

Licensed under **GPL-3.0-only** — see [LICENSE](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE).

---

<div align="center">
Made with ☕ by <a href="https://franciscosolis.cl">Fran</a>
</div>
