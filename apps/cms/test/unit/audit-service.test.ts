import { env } from 'cloudflare:test'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '@/db/client'
import type { AppEnv } from '@/env'
import { getActorContext, getRequestContext, recordAudit } from '@/services/audit'
import { auditLogs, clearDatabase, countRows, db, readAuditLog } from '../helpers/db'

beforeEach(clearDatabase)

describe('recordAudit', () => {
  it('appends a row with every field it was given', async () => {
    await recordAudit(db(), {
      event: 'content.created',
      actorEmail: 'fran@franciscosolis.cl',
      actorId: 'editor-1',
      resourceType: 'content_entries',
      resourceId: 'entry-1',
      ip: '203.0.113.9',
      userAgent: 'CMS/1.0',
      metadata: { collection: 'projects', slug: 'a-project' },
    })

    expect(await readAuditLog()).toEqual([
      {
        event: 'content.created',
        actor_email: 'fran@franciscosolis.cl',
        actor_id: 'editor-1',
        resource_type: 'content_entries',
        resource_id: 'entry-1',
        ip: '203.0.113.9',
        user_agent: 'CMS/1.0',
        metadata: { collection: 'projects', slug: 'a-project' },
      },
    ])
  })

  it('nulls every optional field that was left out', async () => {
    await recordAudit(db(), { event: 'email.sent' })

    const [row] = await readAuditLog()
    expect(row).toEqual({
      event: 'email.sent',
      actor_email: null,
      actor_id: null,
      resource_type: null,
      resource_id: null,
      ip: null,
      user_agent: null,
      metadata: null,
    })
  })

  it('stores null metadata rather than the string "null"', async () => {
    await recordAudit(db(), { event: 'legal.deleted', metadata: null })

    const row = await env.DB.prepare('SELECT metadata FROM audit_logs').first<{ metadata: string | null }>()
    expect(row?.metadata).toBeNull()
  })

  it('gives every row its own id', async () => {
    await recordAudit(db(), { event: 'content.created' })
    await recordAudit(db(), { event: 'content.created' })

    const { results } = await env.DB.prepare('SELECT DISTINCT id FROM audit_logs').all<{ id: string }>()
    expect(results).toHaveLength(2)
  })

  it('stamps created_at with the current time in unix seconds', async () => {
    const before = Math.floor(Date.now() / 1000)
    await recordAudit(db(), { event: 'content.updated' })
    const after = Math.floor(Date.now() / 1000)

    const row = await env.DB.prepare('SELECT created_at FROM audit_logs').first<{ created_at: number }>()

    // The column default is `unixepoch()`, so this is seconds — a millisecond value would land
    // thousands of years out and read back as an unusable date.
    expect(row?.created_at).toBeGreaterThanOrEqual(before)
    expect(row?.created_at).toBeLessThanOrEqual(after)
  })

  it('reads the stamp back as a real date rather than a raw number', async () => {
    await recordAudit(db(), { event: 'content.updated' })

    const [row] = await db().select().from(auditLogs)
    expect(row?.createdAt).toBeInstanceOf(Date)
    expect(Math.abs((row?.createdAt.getTime() ?? 0) - Date.now())).toBeLessThan(60_000)
  })

  it('swallows a write failure instead of turning a successful edit into a 500', async () => {
    // The trail is a diagnostic aid, not a transactional guarantee.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = {
      insert: () => ({
        values: async () => {
          throw new Error('D1_ERROR: no such table: audit_logs')
        },
      }),
    } as unknown as Database

    await expect(recordAudit(broken, { event: 'content.created' })).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith('failed to write audit log', 'content.created', expect.any(Error))
    error.mockRestore()
  })

  it('does not write a row when the insert fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = {
      insert: () => ({
        values: async () => {
          throw new Error('boom')
        },
      }),
    } as unknown as Database

    await recordAudit(broken, { event: 'content.created' })
    expect(await countRows('audit_logs')).toBe(0)
    error.mockRestore()
  })
})

describe('getRequestContext', () => {
  /** Runs one request through a throwaway Hono app so the helper sees a real `Context`. */
  const contextFrom = async (headers: Record<string, string>) => {
    const app = new Hono<AppEnv>()
    let captured: ReturnType<typeof getRequestContext> | null = null
    app.get('/', (c) => {
      captured = getRequestContext(c)
      return c.body(null, 204)
    })

    await app.request('https://cms.internal/', { headers })
    return captured as unknown as ReturnType<typeof getRequestContext>
  }

  it('reads the client fingerprint off Cloudflare\'s headers', async () => {
    expect(await contextFrom({ 'CF-Connecting-IP': '198.51.100.7', 'User-Agent': 'CMS/2.0' })).toEqual({
      ip: '198.51.100.7',
      userAgent: 'CMS/2.0',
    })
  })

  it('nulls what the request does not carry', async () => {
    expect(await contextFrom({})).toEqual({ ip: null, userAgent: null })
  })

  it('does not fall back to another address header', async () => {
    // Only Cloudflare's own header is trusted; `X-Forwarded-For` is client-supplied.
    expect(await contextFrom({ 'X-Forwarded-For': '203.0.113.1' })).toEqual({ ip: null, userAgent: null })
  })
})

describe('getActorContext', () => {
  it('reads the actor off the authenticated editor on the context', async () => {
    const app = new Hono<AppEnv>()
    let captured: ReturnType<typeof getActorContext> | null = null
    app.get('/', (c) => {
      c.set('editor', {
        id: 'editor-9',
        email: 'fran@franciscosolis.cl',
        name: null,
        picture: null,
        sessionId: 'session-1',
        applicationId: 'franciscosolis-cms',
        roles: [],
        permissions: [],
        claims: {} as never,
      })
      captured = getActorContext(c)
      return c.body(null, 204)
    })

    await app.request('https://cms.internal/')
    expect(captured).toEqual({ actorEmail: 'fran@franciscosolis.cl', actorId: 'editor-9' })
  })
})
