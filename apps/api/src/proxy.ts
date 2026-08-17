import type { Context, Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import type { Env } from '@/env'
import { SERVICE_MODULES, type RegisteredModule } from '@/services'
import type { RemoteComponent } from '@/openapi'

type GatewayApp = Hono<{ Bindings: Env }>

/** Path prefix a module is mounted on, e.g. `/landing`. */
const prefixOf = (module: RegisteredModule) => `/${module.name}`

/**
 * The Request the module receives: the caller's, with only the `/<name>` prefix removed from the
 * path. Scheme, host, port and query string are left alone on purpose — the modules build absolute
 * URLs out of what they are handed (auth derives its JWT issuer and its `redirect_uri` allowlist
 * that way), so rewriting the origin would break sign-in while still forwarding the right path.
 */
const forwardedRequest = (module: RegisteredModule, c: Context<{ Bindings: Env }>) => {
  const url = new URL(c.req.url)
  url.pathname = url.pathname.slice(prefixOf(module).length) || '/'

  const request = new Request(url, c.req.raw)
  return 'redirect' in module ? new Request(request, { redirect: module.redirect }) : request
}

/** Forwards a request to the module's Worker over its service binding. */
const proxyTo = (module: RegisteredModule) => (c: Context<{ Bindings: Env }>) => {
  const forwarded = forwardedRequest(module, c)

  if (!('forwardHeaders' in module)) return c.env[module.binding].fetch(forwarded)

  return c.env[module.binding].fetch(forwarded, {
    headers: Object.fromEntries(module.forwardHeaders.map((header) => [header, c.req.header(header) ?? ''])),
  })
}

/** Mounts an `ALL /<name>/*` proxy for every module in the registry. */
const registerServiceProxies = (app: GatewayApp) => {
  for (const module of SERVICE_MODULES) {
    app.all(
      `${prefixOf(module)}/*`,
      describeRoute({
        description: module.description,
        tags: [module.tag],
        responses: {
          200: { description: `Response forwarded from the ${module.name} Worker` },
        },
      }),
      proxyTo(module),
    )
  }

  return app
}

/**
 * Where to fetch each module's own OpenAPI document and under which prefix it gets mounted in the
 * combined one. The hostname is a placeholder: a service binding routes by binding, not by DNS.
 */
const remoteSpecComponents = (env: Env): RemoteComponent[] => SERVICE_MODULES.map((module) => ({
  prefix: prefixOf(module),
  fetchSpec: () => env[module.binding].fetch(new Request(`https://${module.name}.internal/openapi.json`)),
}))

export { registerServiceProxies, remoteSpecComponents }
