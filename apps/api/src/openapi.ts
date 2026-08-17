import type { generateSpecs } from 'hono-openapi'

type Spec = Awaited<ReturnType<typeof generateSpecs>>
type RemoteSpec = { paths?: Record<string, unknown>; components?: Record<string, unknown> }

/** An internal component whose OpenAPI spec is mounted under `prefix`. */
type RemoteComponent = {
  prefix: string
  fetchSpec: () => Promise<Response>
}

/**
 * Merges the OpenAPI spec of internal components (Workers reached over a service binding) into
 * `spec`, mounting their routes under the given `prefix`. A component that is down does not break
 * the rest of the spec.
 */
const mergeRemoteSpecs = async (spec: Spec, components: RemoteComponent[]) => {
  await Promise.all(components.map(async ({ prefix, fetchSpec }) => {
    try {
      const res = await fetchSpec()
      if (!res.ok) return

      const remote = await res.json() as RemoteSpec
      for (const [path, item] of Object.entries(remote.paths ?? {})) {
        spec.paths[`${prefix}${path === '/' ? '' : path}`] = item as (typeof spec.paths)[string]
      }
      Object.assign(spec.components, remote.components)
    } catch {
      // Component unavailable; it is skipped in the combined spec.
    }
  }))
}

export { mergeRemoteSpecs }
export type { RemoteComponent }
