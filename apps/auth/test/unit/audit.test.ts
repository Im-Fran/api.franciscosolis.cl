import { env } from 'cloudflare:test'
import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { getDb } from '@/db/client'
import { auditLogs } from '@/db/schema'
import type { AppEnv } from '@/env'
import { getRequestContext, recordAudit } from '@/services/audit'
import { createUser, db, SEED } from '../helpers/db'

const latestFor = async (userId: string) => {
  const [row] = await db()
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.userId, userId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(1)
  return row ?? null
}

describe('recordAudit', () => {
  it('appends a row with the event, the actors and the serialised metadata', async () => {
    const user = await createUser()

    await recordAudit(db(), {
      event: 'token.issued',
      userId: user.id,
      applicationId: SEED.webAppId,
      ip: '198.51.100.4',
      userAgent: 'probe/2.0',
      metadata: { provider: 'google', session_id: 'abc' },
    })

    const row = await latestFor(user.id)
    expect(row).toMatchObject({
      event: 'token.issued',
      applicationId: SEED.webAppId,
      ip: '198.51.100.4',
      userAgent: 'probe/2.0',
    })
    expect(JSON.parse(row?.metadata ?? 'null')).toEqual({ provider: 'google', session_id: 'abc' })
    expect(row?.createdAt).toBeInstanceOf(Date)
  })

  it('normalises every optional field to null rather than leaving it undefined', async () => {
    const user = await createUser()
    await recordAudit(db(), { event: 'session.revoked', userId: user.id })

    const row = await latestFor(user.id)
    expect(row).toMatchObject({ applicationId: null, ip: null, userAgent: null, metadata: null })
  })

  it('accepts an event with no user at all, as the magic link request path needs', async () => {
    await recordAudit(db(), { event: 'magic_link.rate_limited', applicationId: SEED.webAppId, metadata: { sent: false } })

    const [row] = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.event, 'magic_link.rate_limited'))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1)

    expect(row?.userId).toBeNull()
  })

  it('swallows a write failure instead of turning a successful sign-in into a 500', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const broken = getDb({
      ...env,
      DB: {
        prepare() {
          throw new Error('D1 is down')
        },
      } as unknown as D1Database,
    })

    await expect(recordAudit(broken, { event: 'token.issued', metadata: { a: 1 } })).resolves.toBeUndefined()
    expect(consoleError).toHaveBeenCalledWith('failed to write audit log', 'token.issued', expect.any(Error))

    consoleError.mockRestore()
  })

  it('keeps rows append-only: a second event does not replace the first', async () => {
    const user = await createUser()

    await recordAudit(db(), { event: 'user.disabled', userId: user.id })
    await recordAudit(db(), { event: 'user.enabled', userId: user.id })

    const rows = await db().select().from(auditLogs).where(eq(auditLogs.userId, user.id))
    expect(rows.map((row) => row.event).sort()).toEqual(['user.disabled', 'user.enabled'])
  })
})

describe('getRequestContext', () => {
  const app = new Hono<AppEnv>().get('/context', (c) => c.json(getRequestContext(c)))

  it('reads the client fingerprint from the headers Cloudflare sets', async () => {
    const response = await app.request(
      '/context',
      { headers: { 'CF-Connecting-IP': '203.0.113.9', 'User-Agent': 'probe/3.0' } },
      env,
    )

    await expect(response.json()).resolves.toEqual({ ip: '203.0.113.9', userAgent: 'probe/3.0' })
  })

  it('reports nulls when the headers are absent, rather than the string "undefined"', async () => {
    const response = await app.request('/context', {}, env)

    await expect(response.json()).resolves.toEqual({ ip: null, userAgent: null })
  })

  it('does not fall back to X-Forwarded-For, which a client can set freely', async () => {
    const response = await app.request('/context', { headers: { 'X-Forwarded-For': '1.2.3.4' } }, env)

    await expect(response.json()).resolves.toMatchObject({ ip: null })
  })
})
