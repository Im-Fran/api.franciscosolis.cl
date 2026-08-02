import type { generateSpecs } from 'hono-openapi'

type Spec = Awaited<ReturnType<typeof generateSpecs>>
type RemoteSpec = { paths?: Record<string, unknown>; components?: Record<string, unknown> }

/** Un componente interno cuyo spec OpenAPI se monta bajo `prefix`. */
type RemoteComponent = {
  prefix: string
  fetchSpec: () => Promise<Response>
}

/**
 * Fusiona el spec OpenAPI de componentes internos (Workers vía service binding) dentro de `spec`,
 * montando sus rutas bajo el `prefix` dado. Un componente caído no rompe el resto del spec.
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
      // Componente no disponible; se omite del spec combinado.
    }
  }))
}

export { mergeRemoteSpecs }
export type { RemoteComponent }
