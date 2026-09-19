<div align="center">

# 🌐 @franciscosolis/translate — Shared Translation Prompt

**The one prompt the `api.franciscosolis.cl` Workers use to draft a translation of a field of prose, and the parsing that turns a model's answer back into a string.**

[![License](https://img.shields.io/badge/license-GPL--3.0--only-blue)](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE)

</div>

---

## 📖 Overview

Three Workers in this monorepo store translations — [`apps/cms`](../../apps/cms/README.md) for the
landing page's content and its legal documents, [`apps/pages`](../../apps/pages/README.md) for the
standalone application pages, and [`apps/support`](../../apps/support/README.md) for the help centre
— and all three offer their editors the same thing: a first draft of one field in one other
language, produced by Workers AI, returned for review and saved through the ordinary `PATCH` that
saves every other override.

What differs between the three is the database the call is metered in (`ai_requests`, one table per
Worker) and the gate in front of it. Not one word of what the model is asked. So the prompt lives
here, once, and each Worker wires it to its own `AI` binding.

The package knows nothing about D1, Hono or `env`. It takes a **runner** — a function that hands an
input to a model and returns its output or `null` — and answers with a translation or `null`. That
indirection is the whole design: metering is the Worker's business, and a string is this file's.

It ships **TypeScript source, not a build**, exactly like
[`@franciscosolis/emails`](../emails/README.md). Wrangler already bundles each Worker with esbuild,
so a build step here would only add an artifact to keep in sync.

---

## ✨ Features

- **One prompt, three services** — an editor's draft reads the same whether it came from the CMS,
  an application page or a help article, because there is only one set of instructions to drift.
- **Everything fails to `null`, nothing throws** — "the model is down", "it timed out", "it answered
  prose instead of JSON" and "the answer is over the field's cap" are one outcome to the person in
  front of it: no draft, write it yourself. A translation is an offer, never a step in saving a
  record.
- **The cap is enforced on the answer** — a model asked to stay under 200 characters usually does,
  and "usually" is not a validator. A draft the API would refuse on save is a dead end the editor
  discovers at the save button, so it is never offered.
- **Markdown survives the round trip** — for a `*body` field the prompt pins the structure byte for
  byte: same headings, lists, tables and code fences, link text translated and link targets left
  alone.
- **A refusal rather than a truncation** — a source over `MAX_SOURCE_CHARS` (8 000) gets no draft at
  all. Long-form bodies here run to 100 000 characters; translating the first 8 000 and calling it a
  draft is the one behaviour worse than declining.
- **`response_format: json_schema` plus a valibot parse** — the schema constrains the grammar, the
  parse decides whether the answer is usable. A model that ignored both and answered in prose is
  treated as no answer.

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|------------|
| Validation | [valibot](https://valibot.dev) |
| Language | [TypeScript](https://www.typescriptlang.org) (strict, no emit) |
| Model | [Workers AI](https://developers.cloudflare.com/workers-ai/), supplied by the consumer |

---

## 🧩 What is in it

| Export | What it is |
|--------|------------|
| `translate` | Runner + request in, translation or `null` out. The only function a Worker calls. |
| `formatForField` | `markdown` for a field whose name ends in `body`, `plain` for everything else. |
| `systemPrompt` | The instructions, exposed so a suite can assert on them. |
| `parseAnswer` | A model's raw output in, a trimmed string or `null` out. |
| `languageName`, `LANGUAGE_NAMES` | Locale → English language name, for the prompt. |
| `MAX_SOURCE_CHARS`, `DEFAULT_TIMEOUT_MS` | The two bounds a consumer restates in its own config. |
| `TRANSLATION_JSON_SCHEMA` | The response schema handed to the model. |

---

## 🚀 Usage

A Worker supplies the runner, which is where its meter lives:

```ts
import { formatForField, translate } from '@franciscosolis/translate'

const draft = await translate(
  (input) =>
    runModel(db, env, {
      kind: 'translate',
      model: env.AI_TEXT_MODEL,
      input,
      inputChars: text.length,
      actorEmail: editor.email,
      timeoutMs: TRANSLATION.timeoutMs,
    }),
  {
    text,
    field: 'title',
    format: formatForField('title'),
    sourceLocale: 'en',
    targetLocale: 'es',
    maxLength: TRANSLATABLE_FIELD_LIMITS.title,
  },
)
```

`draft` is a string or `null`. Every route that calls this answers `200` with
`{ translation: null }` on a `null` rather than an error status, because the editor's next step is
the same either way.

`apps/cms/src/services/ai.ts` is the reference wiring, and `apps/cms/src/routes/admin/translate.ts`
the reference route.

---

## 🧱 Changing the prompt

The prompt is written as rules rather than as a persona, and every rule is defending against a
failure seen while building it: a model that answers the text instead of translating it, one that
"improves" a summary on the way through, one that translates the words inside a Markdown link
target, and one that wraps its answer in a friendly sentence. Do not tidy them into prose.

A change here changes all three services at once, so cover it from
`apps/cms/test/unit/translate.test.ts`. Tests live in the consuming Workers on purpose: those run
inside `workerd`, which is the runtime that actually has to execute this code.

---

## 🌍 Adding a language

Nothing here has to change. `languageName` falls back to the locale tag, which still reads as an
instruction ("translate to `pt-BR`"), so a service can publish a new language before this package
knows its name — adding it to `LANGUAGE_NAMES` only improves the phrasing.

The names are English on purpose: they go into a prompt, not into an interface. "Translate to
Spanish" is a phrase every instruction-tuned model has seen a million times, and the website keeps
its own localised list for the labels a human reads.

---

## ⏱️ The two numbers

| Constant | Value | Why |
|----------|-------|-----|
| `MAX_SOURCE_CHARS` | `8000` | Above this there is no draft. A document longer than this is translated in pieces by the person who wrote it. |
| `DEFAULT_TIMEOUT_MS` | `15000` | Below the website's own 20-second request timeout, so an answer has time to travel. Moving one means checking the other. |

The timeout bounds the *response*, not the spend: `env.AI.run` takes no `AbortSignal`, so a model
that keeps going after the race is lost is still billed. That is why every consumer also keeps an
hourly per-editor limit over its `ai_requests` table — Workers AI is metered per neuron with no
per-Worker cap, and without a ceiling the first sign of a loop in a front-end is the invoice.

---

## 📄 License

Licensed under **GPL-3.0-only** — see [LICENSE](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE).

---

<div align="center">
Made with ☕ by <a href="https://franciscosolis.cl">Fran</a>
</div>
