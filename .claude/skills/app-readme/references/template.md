<!--
  Fill-in skeleton for an app README in this monorepo. Delete a section the app has nothing
  for, and delete every one of these comments. See ../SKILL.md for what each section owes.
-->

<div align="center">

# <emoji> <name> — <role in three to five words>

**One sentence: what this Worker is, and where it is reached.**

[![License](https://img.shields.io/badge/license-GPL--3.0--only-blue)](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE)

</div>

---

## 📖 Overview

<!-- Not public; the gateway (apps/api) proxies it over a service binding; base URL. -->
<!-- What it owns. Where the public/authenticated split falls. -->

---

## ✨ Features

- **<capability>** — <what it does, and why it was built that way>.

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers (`nodejs_compat`) |
| Framework | [Hono](https://hono.dev) + [hono-openapi](https://www.npmjs.com/package/hono-openapi) |
| Validation | [valibot](https://valibot.dev) |
| Language | TypeScript (strict) |

---

## 📋 Requirements

<!-- Only what goes beyond `pnpm install`. -->

---

## 🚀 Getting Started

Dependencies are installed from the **monorepo root** (`pnpm install`).

### 1. <first real step>

```bash
```

### 2. Run it

```bash
cd apps/<name> && pnpm run dev
```

<!-- The real port from the dev script. -->

---

## 📡 API

<!-- ### Public / ### Editorial (Bearer token required) / ### Admin (permission-gated) -->

| Method | Route | Description |
|--------|-------|-------------|

The full, always-current description is the OpenAPI document at
`https://api.franciscosolis.cl/openapi.json`.

---

## ⚙️ Configuration

| Variable | Purpose |
|----------|---------|

<!-- Then one sentence listing the bindings. Never a secret value. -->

---

## 🌐 Deployment

```bash
cd apps/<name> && pnpm run deploy
```

<!-- Exact Worker name the gateway's binding needs. Migration note if stateful. -->

---

## 📄 License

Licensed under **GPL-3.0-only** — see [LICENSE](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE).

---

<div align="center">
Made with ☕ by <a href="https://franciscosolis.cl">Fran</a>
</div>
