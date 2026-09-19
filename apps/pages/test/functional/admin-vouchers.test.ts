import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailSender } from '@/env'
import { clearDatabase, readAuditLog, seedApplication, seedPurchase, seedVoucher } from '../helpers/db'
import { asBuyer, asEditor } from '../helpers/tokens'

/**
 * Vouchers: issuing, re-issuing, re-sending and voiding.
 *
 * The rule every test here is about is that a voucher is a *document*. It is never edited, because
 * every copy already in an inbox would become a forgery of the row, and at most one is live per sale,
 * because two valid receipts for one payment is how the same sale gets claimed twice.
 */

const admin = async (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://pages.test/admin${path}`, { ...init, headers: { ...(await asEditor()), ...init.headers } })

const data = async <T>(response: Response): Promise<T> => ((await response.json()) as { data: T }).data

let realEmail: EmailSender
let sent: ReturnType<typeof vi.fn>

beforeEach(async () => {
  await clearDatabase()
  realEmail = env.EMAIL
  sent = vi.fn(async () => ({ messageId: 'test-message' }))
  ;(env as { EMAIL: EmailSender }).EMAIL = { send: sent } as unknown as EmailSender
})

afterEach(() => {
  ;(env as { EMAIL: EmailSender }).EMAIL = realEmail
})

const seedSale = async () => {
  const app = await seedApplication({ slug: 'openbattery', name: 'OpenBattery' })
  const sale = await seedPurchase({ applicationId: app.id, applicationSlug: app.slug, environment: 'sandbox' })
  return { app, sale }
}

describe('POST /admin/applications/:applicationId/sales/:saleId/vouchers', () => {
  const issue = (applicationId: string, saleId: string, payload: Record<string, unknown> = {}) =>
    admin(`/applications/${applicationId}/sales/${saleId}/vouchers`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })

  it('issues a numbered voucher against the sale and emails it', async () => {
    const { app, sale } = await seedSale()

    const voucher = await data<{ number: string; status: string; issued_by: string; sent_count: number; amount: number }>(
      await issue(app.id, sale.id),
    )

    expect(voucher.number).toMatch(/^FS-\d{4}-000001$/)
    expect(voucher.status).toBe('issued')
    expect(voucher.issued_by).toBe('fran@franciscosolis.cl')
    expect(voucher.sent_count).toBe(1)
    // Snapshotted from the sale, not read back through it: the receipt has to say in December what
    // it said in March, for a price that has since changed.
    expect(voucher.amount).toBe(4990)
    expect(sent).toHaveBeenCalledTimes(1)
  })

  it('numbers the second voucher of the year after the first', async () => {
    const { app, sale } = await seedSale()
    const other = await seedPurchase({
      applicationId: app.id,
      applicationSlug: app.slug,
      email: 'two@example.com',
      environment: 'sandbox',
    })

    const first = await data<{ number: string }>(await issue(app.id, sale.id, { notify: false }))
    const second = await data<{ number: string }>(await issue(app.id, other.id, { notify: false }))

    expect(first.number.endsWith('000001')).toBe(true)
    expect(second.number.endsWith('000002')).toBe(true)
  })

  /** Correcting a receipt is a re-issue, and the one it replaces has to stop being valid. */
  it('voids the live voucher it replaces, keeping it on the record', async () => {
    const { app, sale } = await seedSale()
    const first = await data<{ id: string }>(await issue(app.id, sale.id, { notify: false }))
    const second = await data<{ id: string; status: string }>(
      await issue(app.id, sale.id, { email: 'work@example.com', notify: false }),
    )

    const vouchers = await data<{ id: string; status: string; void_reason: string | null }[]>(
      await admin(`/applications/${app.id}/vouchers`),
    )

    expect(vouchers).toHaveLength(2)
    expect(vouchers.find((row) => row.id === first.id)).toMatchObject({ status: 'void', void_reason: 'superseded' })
    expect(vouchers.find((row) => row.id === second.id)?.status).toBe('issued')
  })

  it('issues to another address without touching the sale', async () => {
    const { app, sale } = await seedSale()

    const voucher = await data<{ email: string }>(
      await issue(app.id, sale.id, { email: 'Work@example.com', notify: false }),
    )

    expect(voucher.email).toBe('work@example.com')
    const rows = await data<{ email: string }[]>(await admin(`/applications/${app.id}/sales`))
    expect(rows[0]?.email).toBe('buyer@example.com')
  })

  it('audits the issue', async () => {
    const { app, sale } = await seedSale()
    const voucher = await data<{ number: string }>(await issue(app.id, sale.id, { notify: false }))

    const [entry] = await readAuditLog()
    expect(entry.event).toBe('voucher.issued')
    expect(entry.metadata).toMatchObject({ number: voucher.number })
  })

  it('404s for a sale of another application', async () => {
    const { sale } = await seedSale()
    const other = await seedApplication({ slug: 'other' })

    expect((await issue(other.id, sale.id)).status).toBe(404)
  })
})

describe('POST /admin/applications/:applicationId/vouchers/:voucherId/send', () => {
  const send = (applicationId: string, voucherId: string, payload: Record<string, unknown> = {}) =>
    admin(`/applications/${applicationId}/vouchers/${voucherId}/send`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })

  it('re-sends to the address it was issued to and counts the send', async () => {
    const { app, sale } = await seedSale()
    const voucher = await seedVoucher({ purchaseId: sale.id, applicationId: app.id, applicationSlug: app.slug })

    const sentVoucher = await data<{ sent_count: number; last_sent_to: string; last_sent_at: string }>(
      await send(app.id, voucher.id),
    )

    expect(sentVoucher.sent_count).toBe(1)
    expect(sentVoucher.last_sent_to).toBe('buyer@example.com')
    expect(sentVoucher.last_sent_at).not.toBeNull()
    expect((sent.mock.calls[0]?.[0] as { to: string[] }).to).toEqual(['buyer@example.com'])
  })

  it('sends a copy elsewhere for one send only, leaving the row as issued', async () => {
    const { app, sale } = await seedSale()
    const voucher = await seedVoucher({ purchaseId: sale.id, applicationId: app.id, applicationSlug: app.slug })

    const result = await data<{ email: string; last_sent_to: string }>(
      await send(app.id, voucher.id, { email: 'Work@example.com' }),
    )

    expect(result.last_sent_to).toBe('work@example.com')
    // Sending somebody a copy at their work address is not a correction to the receipt.
    expect(result.email).toBe('buyer@example.com')
  })

  /** The number is read when somebody insists they never received it, so a failed send must not count. */
  it('does not count a send that failed', async () => {
    const { app, sale } = await seedSale()
    const voucher = await seedVoucher({ purchaseId: sale.id, applicationId: app.id, applicationSlug: app.slug })
    sent.mockRejectedValueOnce(new Error('mail is down'))

    expect((await send(app.id, voucher.id)).status).toBe(502)

    const row = await data<{ sent_count: number }>(await admin(`/applications/${app.id}/vouchers/${voucher.id}`))
    expect(row.sent_count).toBe(0)
  })

  it('refuses to re-send a void voucher', async () => {
    const { app, sale } = await seedSale()
    const voucher = await seedVoucher({
      purchaseId: sale.id,
      applicationId: app.id,
      applicationSlug: app.slug,
      status: 'void',
      voidedAt: new Date(),
    })

    expect((await send(app.id, voucher.id)).status).toBe(409)
    expect(sent).not.toHaveBeenCalled()
  })

  it('audits the send with where it went', async () => {
    const { app, sale } = await seedSale()
    const voucher = await seedVoucher({ purchaseId: sale.id, applicationId: app.id, applicationSlug: app.slug })
    await send(app.id, voucher.id, { email: 'work@example.com' })

    const [entry] = await readAuditLog()
    expect(entry.event).toBe('voucher.sent')
    expect(entry.metadata).toMatchObject({ to: 'work@example.com', sent_count: 1 })
  })
})

describe('POST /admin/applications/:applicationId/vouchers/:voucherId/void', () => {
  it('voids with a reason and keeps the row', async () => {
    const { app, sale } = await seedSale()
    const voucher = await seedVoucher({ purchaseId: sale.id, applicationId: app.id, applicationSlug: app.slug })

    const voided = await data<{ status: string; voided_by: string; void_reason: string; voided_at: string }>(
      await admin(`/applications/${app.id}/vouchers/${voucher.id}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'sent to the wrong person' }),
      }),
    )

    expect(voided.status).toBe('void')
    expect(voided.voided_by).toBe('fran@franciscosolis.cl')
    expect(voided.void_reason).toBe('sent to the wrong person')
    expect(voided.voided_at).not.toBeNull()
  })

  it('keeps the first reason and the first date when voided twice', async () => {
    const { app, sale } = await seedSale()
    const voucher = await seedVoucher({ purchaseId: sale.id, applicationId: app.id, applicationSlug: app.slug })
    const url = `/applications/${app.id}/vouchers/${voucher.id}/void`

    const first = await data<{ voided_at: string }>(
      await admin(url, { method: 'POST', body: JSON.stringify({ reason: 'first' }) }),
    )
    const second = await data<{ voided_at: string; void_reason: string }>(
      await admin(url, { method: 'POST', body: JSON.stringify({ reason: 'second' }) }),
    )

    expect(second.void_reason).toBe('first')
    // Compared to the second: D1 stores these as unix seconds, so the first response — built from
    // the in-memory `Date` before the write — carries milliseconds the row never kept.
    expect(Math.floor(Date.parse(second.voided_at) / 1000)).toBe(Math.floor(Date.parse(first.voided_at) / 1000))
  })
})

describe('GET /me/vouchers', () => {
  it('gives a buyer their own receipts, void ones included, and nobody else\'s', async () => {
    const { app, sale } = await seedSale()
    await seedVoucher({ purchaseId: sale.id, applicationId: app.id, applicationSlug: app.slug, number: 'FS-2026-000001' })
    await seedVoucher({
      purchaseId: sale.id,
      applicationId: app.id,
      applicationSlug: app.slug,
      number: 'FS-2026-000002',
      status: 'void',
      voidedAt: new Date(),
    })
    await seedVoucher({
      purchaseId: sale.id,
      applicationId: app.id,
      applicationSlug: app.slug,
      number: 'FS-2026-000003',
      email: 'somebody@example.com',
    })

    const rows = await data<{ number: string; status: string }[]>(
      await SELF.fetch('https://pages.test/me/vouchers', { headers: await asBuyer() }),
    )

    expect(rows.map((row) => row.number).sort()).toEqual(['FS-2026-000001', 'FS-2026-000002'])
  })

  it('never exposes who issued a voucher or why it was voided', async () => {
    const { app, sale } = await seedSale()
    await seedVoucher({
      purchaseId: sale.id,
      applicationId: app.id,
      applicationSlug: app.slug,
      issuedBy: 'fran@franciscosolis.cl',
      voidReason: 'internal note',
    })

    const rows = await data<Record<string, unknown>[]>(
      await SELF.fetch('https://pages.test/me/vouchers', { headers: await asBuyer() }),
    )

    expect(rows[0]).not.toHaveProperty('issued_by')
    expect(rows[0]).not.toHaveProperty('void_reason')
  })

  it('requires a token', async () => {
    expect((await SELF.fetch('https://pages.test/me/vouchers')).status).toBe(401)
  })
})
