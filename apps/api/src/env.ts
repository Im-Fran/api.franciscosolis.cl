import type { ServiceBinding } from '@/services'

/**
 * One `Fetcher` per module in the service registry. Declaring it this way means a new entry in
 * `src/services.ts` is a type error until its service binding exists in `wrangler.jsonc`, instead
 * of failing at runtime with an undefined binding.
 */
type Env = Record<ServiceBinding, Fetcher>

export type { Env }
