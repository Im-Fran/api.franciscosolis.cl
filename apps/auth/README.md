<div align="center">

# 🔐 auth — Centralized Authentication

**Internal Cloudflare Worker behind `api.franciscosolis.cl/auth`: OAuth 2.0 authorization code flow with PKCE, magic link and Google sign-in, roles and permissions on D1.**

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

Accounts, identities, applications, roles, permissions, invitations, sessions and an audit trail
all live in the `franciscosolis_auth` D1 database, accessed through **Drizzle ORM**.

---

## ✨ Features

- **Authorization code + PKCE for every provider** — the browser only ever carries a one-time
  `code`; tokens are fetched with a separate `POST /oauth/token` bound to the client's
  `code_verifier`.
- **Pluggable providers** — a provider's only contract is producing a verified `ProviderProfile`.
  Account resolution, code issuance and the redirect back are shared, so adding a provider is a
  descriptor plus a routes file.
- **Magic link sign-in** — emailed from `FranciscoSolis <hola@mail.franciscosolis.cl>` through
  Cloudflare Email Sending. The link carries only an opaque token; the redirect target is stored
  server-side and cannot be rewritten by a mail client.
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

### 6. Run

```bash
pnpm run dev            # from the repo root, runs every Worker in parallel
```

`auth` listens on `http://localhost:8789` (inspector `9231`), and is reachable through the gateway
at `http://localhost:8787/auth/*`.

---

## 🔑 Sign-in flow

Both providers produce the same result: a one-time `code` on the client's redirect URI.

```
1. Client generates code_verifier + code_challenge (S256) and a state.

2a. Magic link                              2b. Google
    POST /auth/magic-link                       GET /auth/oauth/google/authorize
      { email, client_id, redirect_uri,           ?client_id&redirect_uri&state
        state, code_challenge }                    &code_challenge
    → 202, link emailed                         → 302 to Google
    user clicks the link                        user approves
    GET /auth/magic-link/callback?token=…       GET /auth/oauth/google/callback?code&state

3. → 302 <redirect_uri>?code=…&state=…

4. POST /auth/oauth/token   (application/x-www-form-urlencoded)
     grant_type=authorization_code
     client_id, code, redirect_uri, code_verifier
   → { access_token, token_type, expires_in, refresh_token, scope, session_id }

5. Authenticated requests: Authorization: Bearer <access_token>
   Refresh:  grant_type=refresh_token&client_id=…&refresh_token=…
```

Access tokens live 15 minutes, refresh tokens 30 days and rotate on every use. Authorization
codes live 2 minutes, magic links 15 minutes.

---

## 📚 Endpoints

All paths are relative to `https://api.franciscosolis.cl/auth`.

### Discovery

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Service status and the available providers |
| `GET` | `/.well-known/jwks.json` | Public keys for offline access token verification |
| `GET` | `/.well-known/oauth-authorization-server` | RFC 8414 metadata |
| `GET` | `/openapi.json` | OpenAPI 3 document |

### Sign-in

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/magic-link` | Request a magic link (always 202) |
| `GET` | `/magic-link/callback` | Consume the link, redirect with an authorization code |
| `GET` | `/oauth/google/authorize` | Start the Google flow |
| `GET` | `/oauth/google/callback` | Google's redirect target |
| `POST` | `/oauth/token` | Exchange a code, or rotate a refresh token |
| `POST` | `/oauth/revoke` | Revoke a refresh token and its session |

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
| `applications` | Registered OAuth clients and their exact-match redirect URIs |
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
