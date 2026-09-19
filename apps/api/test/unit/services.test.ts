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

  it('declares one entry per path, and one binding per module', () => {
    // Every entry owns a distinct `/<name>/*` route, aliases included: two entries on one path
    // would mean whichever was registered first silently won.
    expect(new Set(SERVICE_MODULES.map(({ name }) => name)).size).toBe(SERVICE_MODULES.length)
    // Bindings are counted over the modules only. A deprecated alias shares its target's binding on
    // purpose — that is what makes it an alias rather than a second Worker.
    expect(new Set(SERVICE_MODULE_NAMES).size).toBe(SERVICE_MODULE_NAMES.length)
    const modules = SERVICE_MODULES.filter((module) => !('deprecated' in module))
    expect(new Set(modules.map(({ binding }) => binding)).size).toBe(modules.length)
  })

  /**
   * An alias is a path this gateway still answers on for compatibility. It is proxied like anything
   * else and left out of everything that *describes* the service, so a client reading `GET /` or
   * the OpenAPI document is never pointed at a path that is on its way out.
   */
  it('keeps a deprecated alias out of the advertised module list, and says why it exists', () => {
    for (const module of SERVICE_MODULES) {
      if ('deprecated' in module) {
        expect(SERVICE_MODULE_NAMES).not.toContain(module.name)
        expect(module.deprecated).not.toBe('')
        // It has to forward somewhere real, or it is a 404 with extra steps.
        expect(SERVICE_MODULES.some((target) => !('deprecated' in target) && target.binding === module.binding)).toBe(
          true,
        )
      }
    }
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
