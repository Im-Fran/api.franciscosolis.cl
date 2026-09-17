import { env } from 'cloudflare:test'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '@/env'

/**
 * A real Hono `Context`, for the services that take one.
 *
 * Anything that opens or ends an SSO session has to set a cookie, which means it needs the context
 * rather than just the database. Faking one is all downside — the cookie helpers read and write it
 * through `c.req.raw` and `c.res` — so a one-route app is run and the context it was handed is kept.
 * The response is still live afterwards: a `Set-Cookie` written once the handler has returned lands
 * on `c.res`, which is what `setCookies` reads back.
 */
const testContext = async (init: { headers?: Record<string, string>; url?: string } = {}) => {
  const app = new Hono<AppEnv>()
  let captured: Context<AppEnv> | null = null

  app.all('*', (c) => {
    captured = c
    return c.body(null, 204)
  })

  await app.fetch(new Request(init.url ?? 'https://auth.internal/', { headers: init.headers }), env)

  if (!captured) {
    throw new Error('the test context was never handed to a handler')
  }
  return captured as Context<AppEnv>
}

/** Every `Set-Cookie` written on a context or a response, in the order they were written. */
const setCookies = (from: Context<AppEnv> | Response) =>
  ('res' in from ? from.res : from).headers.getSetCookie()

/** The value of one cookie out of a `Set-Cookie` list, or null when it was not set. */
const cookieValue = (from: Context<AppEnv> | Response, name: string) => {
  const header = setCookies(from).find((line) => line.startsWith(`${name}=`))
  return header ? (header.slice(name.length + 1).split(';')[0] ?? null) : null
}

/** A `Cookie` request header carrying one cookie, as a browser would send it back. */
const cookieHeader = (name: string, value: string) => ({ Cookie: `${name}=${value}` })

export { cookieHeader, cookieValue, setCookies, testContext }
