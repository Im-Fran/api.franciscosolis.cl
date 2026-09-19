# CLAUDE.md

## LANGUAGE RULE — MANDATORY, NO EXCEPTIONS

ALL code, comments, variable/function names, commit messages, PR descriptions, and any
other written content in this repository MUST be in English. This applies regardless of
the language the user writes to Claude Code in. Never write Spanish (or any other
language) into files, commits, or code in this repo.

## Purpose

`@franciscosolis/translate` holds the one prompt this monorepo uses to machine-translate a
field of prose, and the parsing that turns a model's answer back into a string. `apps/cms`,
`apps/marketplace` and `apps/support` all import it; none of them writes a prompt of its own. It is
the second entry under `packages/` and the second non-Worker workspace package.

A consumer supplies a `runner` — a function that hands an input to a model and returns its
output or `null` — and gets back a translation or `null`. That is the whole surface.

## Commands (run from the repo root)

- `pnpm --filter @franciscosolis/translate run typecheck` → `tsc --noEmit`.

There is no `dev`, `build`, `deploy` or `test` script, so the root `-r` scripts skip this
package, exactly as they skip `packages/emails`. It ships TypeScript source that each Worker
bundles, and its behaviour is covered from inside `workerd` by the consuming suites —
`apps/cms/test/unit/translate.test.ts` is the one that exercises this package directly.

## Source layout

- `src/index.ts` — the public API, plus `formatForField`. Anything a Worker imports has to be
  re-exported here.
- `src/languages.ts` — locale → English language name, for the prompt.
- `src/translate.ts` — the system prompt, the JSON schema, the parse and `translate`.

## Architecture notes (non-obvious)

- **It knows nothing about D1, Hono or `env`, and that is the reason it can be shared.** The
  three Workers differ in the database the call is metered in (`ai_requests`, per Worker) and
  the gate in front of it (`requireEditor` in two of them, `support:admin` in the third) —
  not in a single word of what the model is asked. Adding an `Env` parameter here would make
  it a fourth copy of each Worker's wiring.
- **Everything fails to `null`; nothing throws.** A translation is an offer, never a step in
  saving a record, so "the model is down", "it timed out", "it answered prose instead of
  JSON" and "the answer is over the field's cap" are one outcome to the person in front of
  it: no draft, write it yourself. Distinguishing them for an editor would be telling them
  about somebody else's outage.
- **The cap is enforced on the answer, not just named in the prompt.** A model asked to stay
  under 200 characters usually does, and "usually" is not a validator — a draft the API would
  refuse on save is a dead end the editor discovers at the save button.
- **The language names are English on purpose.** They go into a prompt, not into a user
  interface: "translate to Spanish" is a phrase every instruction-tuned model has seen a
  million times, and the front-end has its own localised list for the labels a human reads. A
  locale missing from the map falls back to its tag, so a service that adds one does not have
  to land a change here first.
- **`MAX_SOURCE_CHARS` (8 000) is a refusal, not a truncation.** Long-form bodies on this site
  run to 100 000 characters, which no chat model translates in one answer inside a Worker's
  time budget. Silently translating the first 8 000 and calling it a draft is the one
  behaviour that would be worse than declining.
- **`DEFAULT_TIMEOUT_MS` (15 s) is deliberately below the website's own 20-second request
  timeout** (`REQUEST_TIMEOUT_MS` in the front-end repository's `src/lib/auth/client.ts`). A
  model call that outlives the browser's patience is billed, answered and thrown away, and the
  editor learns nothing. Moving one of the two numbers means checking the other.
- **`formatForField` is a rule, not a registry**: anything ending in `body` is Markdown, the
  rest is plain text. The front-end's `controlForField` applies the identical test to pick a
  control. Three copies of one rule, deliberately — the alternative is a field-by-field
  registry in four places, and the rule is the thing that stays true when a service adds a
  field.
- **The prompt is written as rules rather than as a persona**, and every rule is defending
  against a failure seen while building it: a model that answers the text instead of
  translating it, one that "improves" a summary on the way through, one that translates the
  words inside a Markdown link target, and one that wraps its answer in a friendly sentence.
  Do not tidy them into prose.
