import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { validator } from 'hono-openapi'
import * as v from 'valibot'
import type { GenericSchema } from 'valibot'

type Issue = { message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }

/** `field.nested: message`, the form a validation failure is reported in. */
const describeIssue = (issue: Issue) => {
  const path = (issue.path ?? []).map((segment) => (typeof segment === 'object' ? String(segment.key) : String(segment))).join('.')
  return path ? `${path}: ${issue.message}` : issue.message
}

/**
 * hono-openapi's validator, answering a failure in this service's error shape — `{ code, error }`
 * plus the individual `issues` — rather than the validator's own, so a client (the panel, or a device
 * logging why its batch was refused) reads one shape for every error.
 */
const validate = <Target extends 'json' | 'query' | 'param', Schema extends GenericSchema>(target: Target, schema: Schema) =>
  validator(target, schema, (result: { success: boolean; error?: ReadonlyArray<Issue> }, c: Context) => {
    if (!result.success) {
      const issues = (result.error ?? []).map(describeIssue)
      return c.json({ code: 400, error: issues[0] ?? 'Invalid request', issues }, 400)
    }
  })

/**
 * Reads an *optional* JSON body against `schema`. For the action routes (revoke, add a key) whose
 * every field is optional: a client that sends no body at all — with or without a JSON content
 * type — is not wrong, and the validator above would call it malformed. Anything that *is* sent is
 * still validated.
 */
const readOptionalJson = async <Schema extends GenericSchema>(c: Context, schema: Schema): Promise<v.InferOutput<Schema>> => {
  const raw = (await c.req.text()).trim()
  let body: unknown = {}
  if (raw) {
    try {
      body = JSON.parse(raw)
    } catch {
      throw new HTTPException(400, { message: 'The request body is not valid JSON' })
    }
  }
  const parsed = v.safeParse(schema, body)
  if (!parsed.success) {
    throw new HTTPException(400, { message: describeIssue(parsed.issues[0] as Issue) })
  }
  return parsed.output
}

export { readOptionalJson, validate }
