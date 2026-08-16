import type { Env } from '@/env'
import { googleProvider } from '@/providers/google'
import { magicLinkProvider } from '@/providers/magic-link'
import type { ProviderDescriptor } from '@/providers/types'

/**
 * Registry of authentication providers. Adding a provider means adding its descriptor here plus a
 * routes file; nothing downstream of `completeAuthentication` needs to change, because every
 * provider converges on the same `ProviderProfile`.
 */
const PROVIDER_REGISTRY: ProviderDescriptor[] = [magicLinkProvider, googleProvider]

/** Descriptors whose required secrets are present, i.e. the ones a client can actually use. */
const getAvailableProviders = (env: Env) => PROVIDER_REGISTRY.filter((provider) => provider.isConfigured(env))

/** Serialised provider list exposed on `GET /` and `GET /providers`. */
const describeProviders = (env: Env) =>
  PROVIDER_REGISTRY.map((provider) => ({
    name: provider.name,
    display_name: provider.displayName,
    initiation: provider.initiation,
    start_path: provider.startPath,
    available: provider.isConfigured(env),
  }))

export { describeProviders, getAvailableProviders, PROVIDER_REGISTRY }
