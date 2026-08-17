import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { SERVICE_MODULES, SERVICE_MODULE_NAMES } from '@/services'

/**
 * The registry in `src/services.ts` is the single place a module is declared, but it cannot reach
 * `wrangler.jsonc` on its own: an entry naming a binding that was never declared there would type
 * check and then fail at runtime with an undefined binding. `env` here is built from the real
 * `wrangler.jsonc`, so these tie the two halves together.
 */
/** `cloudflare:test` leaves `ProvidedEnv` unaugmented, so the bindings are read as plain data. */
const bindings = env as unknown as Record<string, Fetcher | undefined>

describe('service registry', () => {
  it.each(SERVICE_MODULES)('$name has a service binding declared in wrangler.jsonc', ({ binding }) => {
    expect(bindings[binding]).toBeDefined()
    expect(typeof bindings[binding]?.fetch).toBe('function')
  })

  it('declares one module per name, with no duplicated prefix or binding', () => {
    expect(new Set(SERVICE_MODULE_NAMES).size).toBe(SERVICE_MODULES.length)
    expect(new Set(SERVICE_MODULES.map(({ binding }) => binding)).size).toBe(SERVICE_MODULES.length)
  })

  // The name becomes a `/<name>/*` route, a stripped path prefix and an OpenAPI mount point, so
  // anything needing escaping would quietly break all three.
  it.each(SERVICE_MODULES)('$name is a single plain path segment', ({ name }) => {
    expect(name).toMatch(/^[a-z][a-z0-9-]*$/)
    expect(encodeURIComponent(name)).toBe(name)
  })

  it('describes every module for the OpenAPI document', () => {
    for (const { description, tag } of SERVICE_MODULES) {
      expect(description).not.toBe('')
      expect(tag).not.toBe('')
    }
  })
})
