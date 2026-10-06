#!/usr/bin/env node
/**
 * Guards the one real cost of Wrangler's named environments: a `dev` environment inherits no
 * bindings and no vars, so every one of them is written twice — once at the top level for
 * production, once under `env.dev` for the development stack.
 *
 * That duplication is not optional (it is how Wrangler works) but it is exactly the kind that rots.
 * Somebody adds a var for production, nothing fails, and months later the development Worker throws
 * an undefined at runtime on a code path nobody exercised before the deploy. Or the reverse, which
 * is worse: a dev environment that quietly keeps a production database name and writes test rows
 * into the real thing.
 *
 * So this asserts, for every app that declares a `dev` environment:
 *
 * - it declares the same binding names and the same `vars` keys as the top level, and no extras;
 * - every resource it names is a *different* resource — database, bucket, Vectorize index, queue
 *   (produced to or consumed from) and target Worker of every service binding;
 * - no var still points at a production host, and the routes it claims are not production's.
 *
 * Run it with `node scripts/check-environments.mjs`; CI runs it as its own job.
 */
import { readFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Keys a named environment *inherits* and therefore must not restate. Wrangler rejects them inside
 * one — "Unexpected fields found in env.dev field: …" — and then carries on with the inherited
 * value, so restating one costs a warning on every deploy and changes nothing. `alias` was
 * restated under `env.dev` in `auth` and `cms` at first, and the dev bundles came out byte for byte
 * the size of the production ones, which is what proved it inherited.
 *
 * This is deliberately not the full list of inheritable keys: `routes` is inheritable too and is
 * checked further down precisely *because* it has to be overridden. These are the ones where
 * restating is both useless and rejected.
 */
const INHERITED_ONLY_KEYS = ['alias']

/** Hosts that belong to production. A dev environment naming one of them is the bug this catches. */
const PRODUCTION_HOSTS = ['api.franciscosolis.cl', 'https://franciscosolis.cl']

/**
 * Strips `//` and comments from JSONC.
 *
 * A regex cannot do this: every one of these config files is full of `https://` inside string
 * values, and a naive strip turns the rest of that line into nothing. So this walks the text once,
 * tracking whether it is inside a string and whether the last character was an escape.
 */
const stripComments = (text) => {
  let out = ''
  let inString = false
  let escaped = false
  let comment = null // 'line' | 'block' | null

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]

    if (comment === 'line') {
      if (char === '\n') {
        comment = null
        out += char
      }
      continue
    }
    if (comment === 'block') {
      if (char === '*' && next === '/') {
        comment = null
        i += 1
      }
      continue
    }
    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      comment = 'line'
      i += 1
      continue
    }
    if (char === '/' && next === '*') {
      comment = 'block'
      i += 1
      continue
    }
    out += char
  }

  return out
}

/** JSONC with trailing commas, as Wrangler accepts them. */
const parseJsonc = (text) => JSON.parse(stripComments(text).replace(/,(\s*[}\]])/g, '$1'))

/** Every binding this repo uses, as `{ name -> identifier }` for one half of a config. */
const bindingsOf = (config) => {
  const bindings = new Map()
  for (const entry of config.d1_databases ?? []) bindings.set(`d1:${entry.binding}`, entry.database_name)
  for (const entry of config.r2_buckets ?? []) bindings.set(`r2:${entry.binding}`, entry.bucket_name)
  for (const entry of config.services ?? []) bindings.set(`service:${entry.binding}`, entry.service)
  for (const entry of config.vectorize ?? []) bindings.set(`vectorize:${entry.binding}`, entry.index_name)
  for (const entry of config.send_email ?? []) bindings.set(`email:${entry.name}`, entry.name)
  if (config.ai) bindings.set(`ai:${config.ai.binding}`, config.ai.binding)
  // Queues are the one kind with two halves. A producer has a binding name, like everything above.
  // A consumer has none — it is keyed by the queue it drains — so it is keyed here by position,
  // which is enough to say "production consumes a queue and dev consumes a different one" without
  // pretending the two halves share a name they do not. A dev producer left on the production queue
  // is the exact failure this script exists for: every sign-in on the development stack would land
  // in somebody's real notification list.
  for (const entry of config.queues?.producers ?? []) bindings.set(`queue:${entry.binding}`, entry.queue)
  for (const [index, entry] of (config.queues?.consumers ?? []).entries()) {
    bindings.set(`queue-consumer:#${index}`, entry.queue)
  }
  return bindings
}

/** Bindings whose identifier is the binding name itself, so "they must differ" cannot apply. */
const SHARED_BY_NATURE = /^(email|ai):/

const problems = []
const apps = readdirSync('apps', { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

for (const app of apps) {
  const path = join('apps', app, 'wrangler.jsonc')
  let config
  try {
    config = parseJsonc(readFileSync(path, 'utf8'))
  } catch (error) {
    problems.push(`${app}: ${path} could not be parsed — ${error.message}`)
    continue
  }

  const dev = config.env?.dev
  if (!dev) {
    problems.push(`${app}: no \`env.dev\` in ${path}. Every app needs one, even an empty \`"dev": {}\` — \`wrangler deploy --env dev\` fails on an environment that is not declared.`)
    continue
  }

  const production = bindingsOf(config)
  const development = bindingsOf(dev)

  for (const [binding, identifier] of production) {
    if (!development.has(binding)) {
      problems.push(`${app}: \`env.dev\` is missing the ${binding} binding, which production declares as "${identifier}".`)
      continue
    }
    const devIdentifier = development.get(binding)
    if (!SHARED_BY_NATURE.test(binding) && devIdentifier === identifier) {
      problems.push(`${app}: ${binding} names "${identifier}" in both environments. The development stack must have its own resource.`)
    }
  }
  for (const binding of development.keys()) {
    if (!production.has(binding)) {
      problems.push(`${app}: \`env.dev\` declares the ${binding} binding and production does not.`)
    }
  }

  for (const key of INHERITED_ONLY_KEYS) {
    if (key in dev) {
      problems.push(`${app}: \`env.dev\` restates \`${key}\`, which a named environment inherits and Wrangler refuses inside one. Delete it — the top-level value already applies to the development stack.`)
    }
  }

  const productionVars = Object.keys(config.vars ?? {}).sort()
  const developmentVars = Object.keys(dev.vars ?? {}).sort()
  for (const name of productionVars) {
    if (!developmentVars.includes(name)) {
      problems.push(`${app}: \`env.dev.vars\` is missing ${name}. A named environment inherits nothing, so it has to be restated.`)
    }
  }
  for (const name of developmentVars) {
    if (!productionVars.includes(name)) {
      problems.push(`${app}: \`env.dev.vars\` declares ${name} and the top level does not.`)
    }
  }

  for (const [name, value] of Object.entries(dev.vars ?? {})) {
    if (typeof value !== 'string') continue
    for (const host of PRODUCTION_HOSTS) {
      if (value.includes(host)) {
        problems.push(`${app}: \`env.dev.vars.${name}\` still points at production ("${value}").`)
      }
    }
  }

  // `routes` is one of the keys a named environment *inherits*, which makes it the sharpest edge
  // here: an app with a production route and no override in `env.dev` deploys the development
  // Worker onto the production hostname.
  const productionPatterns = (config.routes ?? []).map((route) => route.pattern)
  if (productionPatterns.length > 0) {
    const developmentPatterns = (dev.routes ?? []).map((route) => route.pattern)
    if (developmentPatterns.length === 0) {
      problems.push(`${app}: production claims ${productionPatterns.join(', ')} and \`env.dev\` overrides no routes. Routes are inherited, so the development Worker would take that hostname.`)
    }
    for (const pattern of developmentPatterns) {
      if (productionPatterns.includes(pattern)) {
        problems.push(`${app}: \`env.dev\` claims the production route ${pattern}.`)
      }
    }
  }
}

if (problems.length > 0) {
  console.error('The development environments have drifted from production:\n')
  for (const problem of problems) console.error(`  • ${problem}`)
  console.error(`\n${problems.length} problem(s). See scripts/check-environments.mjs for what each check is defending against.`)
  process.exit(1)
}

console.log(`Checked ${apps.length} app(s): every \`env.dev\` mirrors its top-level config and names resources of its own.`)
