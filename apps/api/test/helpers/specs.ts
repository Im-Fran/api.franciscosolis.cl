import type { mergeRemoteSpecs } from '@/openapi'

type Spec = Parameters<typeof mergeRemoteSpecs>[0]

/**
 * A stand-in for what `generateSpecs` hands `mergeRemoteSpecs`: the gateway's own document, with
 * one path and one component of its own so a test can tell what the merge preserved and what it
 * overwrote.
 */
const gatewaySpec = () => ({
  openapi: '3.1.0',
  info: { title: 'FranciscoSolis - Rest API', version: '1.0.0' },
  paths: { '/': { get: { operationId: 'getIndex' } } },
  components: { schemas: { GatewayStatus: { type: 'object' } } },
} as unknown as Spec)

/** Reads a merged spec back as plain data, since `Spec` is deliberately opaque. */
const asRecord = (spec: Spec) => spec as unknown as {
  paths: Record<string, unknown>
  components: Record<string, unknown> | undefined
}

const serving = (body: unknown, init?: ResponseInit) => () => Promise.resolve(Response.json(body, init))
const servingRaw = (body: BodyInit | null, init?: ResponseInit) => () => Promise.resolve(new Response(body, init))
const rejecting = (message: string) => () => Promise.reject(new Error(message))
const throwing = (message: string): () => Promise<Response> => () => {
  throw new Error(message)
}

/** The shape every stub module answers `/openapi.json` with. */
const moduleSpec = (module: string) => ({
  openapi: '3.1.0',
  info: { title: module, version: '1.0.0' },
  paths: {
    '/': { get: { summary: `${module} root` } },
    '/thing': { get: { summary: `${module} thing` } },
  },
  components: { schemas: { [`${module}Schema`]: { type: 'object' } } },
})

export { asRecord, gatewaySpec, moduleSpec, rejecting, serving, servingRaw, throwing }
export type { Spec }
