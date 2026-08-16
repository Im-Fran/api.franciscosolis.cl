/**
 * Miniflare definitions for the three internal Workers this gateway is bound to.
 *
 * They are real auxiliary Workers rather than hand-written `Fetcher` objects, so the tests exercise
 * an actual Cloudflare service binding — the same path production takes — instead of a stand-in
 * whose semantics could quietly diverge from it.
 *
 * Each stub answers `/openapi.json` with a small spec (so the merge in `src/openapi.ts` can be
 * asserted on) and echoes every other request back as JSON, which is what lets a test see the
 * method, the rewritten path, the headers and the body that actually crossed the binding.
 */

/** Name of the module the gateway strips from the path before forwarding. */
type ModuleName = 'landing' | 'auth' | 'cms'

const echoWorkerScript = (module: ModuleName) => `
export default {
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === '/openapi.json') {
      return Response.json({
        openapi: '3.1.0',
        info: { title: '${module}', version: '1.0.0' },
        paths: {
          '/': { get: { summary: '${module} root' } },
          '/thing': { get: { summary: '${module} thing' } },
        },
        components: { schemas: { ${module}Schema: { type: 'object' } } },
      })
    }

    // A redirect the gateway must hand back to the browser instead of following: the auth module
    // answers a completed sign-in with a 302 carrying a one-time authorization code.
    if (url.pathname === '/redirect') {
      return new Response(null, { status: 302, headers: { Location: 'https://example.test/callback?code=abc' } })
    }

    if (url.pathname === '/boom') {
      return new Response('upstream exploded', { status: 500 })
    }

    return Response.json({
      module: '${module}',
      method: request.method,
      pathname: url.pathname,
      search: url.search,
      body: request.body ? await request.text() : null,
      headers: Object.fromEntries(request.headers),
    })
  },
}
`

const stubWorker = (module: ModuleName) => ({
  name: module,
  modules: true,
  script: echoWorkerScript(module),
  compatibilityDate: '2026-07-31',
  compatibilityFlags: ['nodejs_compat'],
})

/** Shape of the JSON an echo stub answers with. Used by the tests to read a forwarded request. */
type EchoedRequest = {
  module: ModuleName
  method: string
  pathname: string
  search: string
  body: string | null
  headers: Record<string, string>
}

const internalWorkers = [stubWorker('landing'), stubWorker('auth'), stubWorker('cms')]

export { internalWorkers, stubWorker }
export type { EchoedRequest, ModuleName }
