import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailSender } from '@/env'
import { clearDatabase, countRows, readAuditLog, seedApplication, seedPurchase } from '../helpers/db'
import { asBuyer, asEditor } from '../helpers/tokens'

/**
 * The sales console of one application: recording a sale taken outside MercadoPago, adding it up,
 * and giving it back.
 *
 * Every test here replaces `env.EMAIL` with a spy. The binding Miniflare provides does work, but a
 * suite that let it work would be a suite whose assertions about receipts are "no exception was
 * thrown" — and the interesting half of a voucher is who it went to and what it said.
 */

const admin = async (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://pages.test/admin${path}`, { ...init, headers: { ...(await asEditor()), ...init.headers } })

const body = async <T>(response: Response): Promise<T> => (await response.json()) as T
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
  vi.restoreAllMocks()
})

describe('POST /admin/applications/:applicationId/sales', () => {
  const record = (applicationId: string, payload: Record<string, unknown>) =>
    admin(`/applications/${applicationId}/sales`, { method: 'POST', body: JSON.stringify(payload) })

  it('records a cash sale as an approved payment, attributed to the editor', async () => {
    const app = await seedApplication({ slug: 'openbattery', pricingMode: 'paid', priceAmount: 4990 })

    const response = await record(app.id, {
      email: 'Cash.Buyer@example.com',
      source: 'cash',
      amount: 4990,
      note: 'Paid at the Ñuñoa stand',
    })

    expect(response.status).toBe(201)
    const { sale } = await data<{ sale: Record<string, unknown> }>(response)
    expect(sale.status).toBe('approved')
    expect(sale.source).toBe('cash')
    // `manual`, not `mercadopago`: the provider holds no transaction for this row, and a
    // reconciliation that trusted `provider` would go looking for one.
    expect(sale.provider).toBe('manual')
    expect(sale.email).toBe('cash.buyer@example.com')
    expect(sale.created_by).toBe('fran@franciscosolis.cl')
    expect(sale.note).toBe('Paid at the Ñuñoa stand')
    expect(sale.linked_to_account).toBe(false)
  })

  /**
   * The one write in this Worker that grants an entitlement with no provider behind it, so the trail
   * has to carry what was granted and on what basis without joining back to a row that can still be
   * edited.
   */
  it('audits the amount and the source, not just the id', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    await record(app.id, { email: 'buyer@example.com', source: 'bank_transfer', amount: 12_000 })

    // Newest first, and the voucher is issued after the sale, so the sale's entry is the second.
    const entry = (await readAuditLog()).find((row) => row.event === 'sale.created')
    expect(entry?.actor_email).toBe('fran@franciscosolis.cl')
    expect(entry?.metadata).toMatchObject({ source: 'bank_transfer', amount: 12_000, kind: 'purchase' })
  })

  it('refuses to record a sale that claims MercadoPago took it', async () => {
    const app = await seedApplication({ slug: 'openbattery' })

    const response = await record(app.id, { email: 'buyer@example.com', source: 'mercadopago', amount: 4990 })

    expect(response.status).toBe(400)
    expect(await countRows('purchases')).toBe(0)
  })

  /** A gift is a sale of zero. The floor that applies to a checkout is about the provider's fee. */
  it('accepts a gift at no charge', async () => {
    const app = await seedApplication({ slug: 'openbattery' })

    const { sale } = await data<{ sale: { amount: number; source: string } }>(
      await record(app.id, { email: 'friend@example.com', source: 'gift', amount: 0 }),
    )

    expect(sale.amount).toBe(0)
    expect(sale.source).toBe('gift')
  })

  it('issues a voucher and emails it, unless told not to', async () => {
    const app = await seedApplication({ slug: 'openbattery' })

    const created = await data<{ voucher: { number: string; sent_count: number; email: string } }>(
      await record(app.id, { email: 'buyer@example.com', source: 'cash', amount: 4990, locale: 'es' }),
    )

    expect(created.voucher.number).toMatch(/^FS-\d{4}-\d{6}$/)
    expect(created.voucher.sent_count).toBe(1)
    expect(sent).toHaveBeenCalledTimes(1)
    const message = sent.mock.calls[0]?.[0] as { to: string[]; subject: string; html: string }
    expect(message.to).toEqual(['buyer@example.com'])
    // Rendered in the locale the sale was recorded with, which is the only chance to get it right.
    expect(message.subject).toContain('comprobante')
    expect(message.html).toContain(created.voucher.number)
  })

  it('records the sale without a receipt when asked not to issue one', async () => {
    const app = await seedApplication({ slug: 'openbattery' })

    const created = await data<{ voucher: null }>(
      await record(app.id, { email: 'buyer@example.com', source: 'cash', amount: 4990, issue_voucher: false }),
    )

    expect(created.voucher).toBeNull()
    expect(await countRows('sale_vouchers')).toBe(0)
    expect(sent).not.toHaveBeenCalled()
  })

  /**
   * The sale is real whether or not the mail binding is. Rolling it back would lose a payment that
   * genuinely happened, so the editor is told the send failed and "Resend" is one click away.
   */
  it('keeps the sale and its voucher when the receipt cannot be emailed', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    sent.mockRejectedValueOnce(new Error('mail is down'))

    const response = await record(app.id, { email: 'buyer@example.com', source: 'cash', amount: 4990 })

    expect(response.status).toBe(502)
    expect(await countRows('purchases')).toBe(1)
    expect(await countRows('sale_vouchers')).toBe(1)
  })

  /**
   * A manual sale has to grant the download, or it is a note to self. It is found by its address,
   * because a copy sold for cash predates the account of the person who bought it.
   */
  it('entitles the recipient even though the sale carries no account id', async () => {
    const app = await seedApplication({ slug: 'openbattery', pricingMode: 'paid', priceAmount: 4990 })
    await record(app.id, { email: 'buyer@example.com', source: 'cash', amount: 4990, issue_voucher: false })

    const access = await data<{ has_paid: boolean; can_download: boolean }>(
      await SELF.fetch('https://pages.test/applications/openbattery/access', {
        headers: await asBuyer({ sub: 'signed-up-later', email: 'buyer@example.com' }),
      }),
    )

    expect(access.has_paid).toBe(true)
    expect(access.can_download).toBe(true)
  })

  /**
   * Backdating has to move the approval and the row together, or the statutory ten days would run
   * from the day somebody got round to typing the sale in.
   */
  it('backdates the approval, and the withdrawal window with it', async () => {
    const app = await seedApplication({ slug: 'openbattery' })

    const { sale } = await data<{
      sale: { approved_at: string; withdrawal: { within_period: boolean; days_left: number } }
    }>(
      await record(app.id, {
        email: 'buyer@example.com',
        source: 'cash',
        amount: 4990,
        occurred_at: '2020-01-01T00:00:00Z',
        issue_voucher: false,
      }),
    )

    expect(sale.approved_at).toBe('2020-01-01T00:00:00.000Z')
    expect(sale.withdrawal.within_period).toBe(false)
    expect(sale.withdrawal.days_left).toBe(0)
  })
})

describe('GET /admin/applications/:applicationId/sales', () => {
  it('lists only this application\'s sales, with its withdrawal window on each', async () => {
    const mine = await seedApplication({ slug: 'openbattery' })
    const other = await seedApplication({ slug: 'other' })
    await seedPurchase({ applicationId: mine.id, applicationSlug: mine.slug })
    await seedPurchase({ applicationId: other.id, applicationSlug: other.slug })

    const rows = await data<{ withdrawal: { deadline: string | null } }[]>(
      await admin(`/applications/${mine.id}/sales`),
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.withdrawal.deadline).not.toBeNull()
  })

  it('narrows by source, which is what separates cash from card', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    await seedPurchase({ applicationId: app.id, applicationSlug: app.slug })
    await seedPurchase({ applicationId: app.id, applicationSlug: app.slug, source: 'cash', provider: 'manual' })

    const rows = await data<{ source: string }[]>(await admin(`/applications/${app.id}/sales?source=cash`))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.source).toBe('cash')
  })

  it('404s for an application that does not exist', async () => {
    expect((await admin('/applications/nope/sales')).status).toBe(404)
  })
})

describe('GET /admin/applications/:applicationId/sales/summary', () => {
  it('separates what arrived from what went back out', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    await seedPurchase({ applicationId: app.id, applicationSlug: app.slug, amount: 4990 })
    await seedPurchase({ applicationId: app.id, applicationSlug: app.slug, amount: 4990, email: 'two@example.com' })
    await seedPurchase({
      applicationId: app.id,
      applicationSlug: app.slug,
      amount: 4990,
      status: 'refunded',
      refundedAmount: 4990,
      refundedAt: new Date(),
      email: 'three@example.com',
    })
    // A pending payment is money that never arrived, so it counts towards neither figure.
    await seedPurchase({
      applicationId: app.id,
      applicationSlug: app.slug,
      amount: 99_000,
      status: 'pending',
      approvedAt: null,
      email: 'four@example.com',
    })

    const summary = await data<{
      gross: number
      returned: number
      net: number
      count: number
      active_count: number
      buyers: number
      by_status: Record<string, { count: number; total: number }>
      environment: string
    }>(await admin(`/applications/${app.id}/sales/summary`))

    expect(summary.gross).toBe(14_970)
    expect(summary.returned).toBe(4990)
    expect(summary.net).toBe(9980)
    expect(summary.count).toBe(4)
    expect(summary.active_count).toBe(2)
    expect(summary.buyers).toBe(2)
    expect(summary.by_status.pending).toEqual({ count: 1, total: 99_000 })
    // Present at zero rather than absent, so a front-end renders a stable set of rows.
    expect(summary.by_status.cancelled).toEqual({ count: 0, total: 0 })
    expect(summary.environment).toBe('sandbox')
  })

  /**
   * A chargeback returns the whole sale regardless of the disputed amount. The fee is not modelled,
   * so the conservative reading is the correct one.
   */
  it('counts a chargeback as the whole sale going back', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    await seedPurchase({
      applicationId: app.id,
      applicationSlug: app.slug,
      amount: 4990,
      status: 'charged_back',
      chargedBackAt: new Date(),
    })

    const summary = await data<{ gross: number; returned: number; net: number }>(
      await admin(`/applications/${app.id}/sales/summary`),
    )

    expect(summary).toMatchObject({ gross: 4990, returned: 4990, net: 0 })
  })

  it('totals only the rows its filters select', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    await seedPurchase({ applicationId: app.id, applicationSlug: app.slug, amount: 4990 })
    await seedPurchase({
      applicationId: app.id,
      applicationSlug: app.slug,
      amount: 1000,
      source: 'gift',
      provider: 'manual',
      email: 'friend@example.com',
    })

    const summary = await data<{ gross: number }>(
      await admin(`/applications/${app.id}/sales/summary?source=gift`),
    )

    expect(summary.gross).toBe(1000)
  })
})

describe('POST /admin/applications/:applicationId/sales/:saleId/refund', () => {
  const refund = (applicationId: string, saleId: string, payload: Record<string, unknown>) =>
    admin(`/applications/${applicationId}/sales/${saleId}/refund`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })

  it('refunds a manual sale without asking any provider, and emails the notice', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    const sale = await seedPurchase({
      applicationId: app.id,
      applicationSlug: app.slug,
      source: 'cash',
      provider: 'manual',
      environment: 'sandbox',
    })

    const refunded = await data<{
      status: string
      refunded_amount: number
      refund_reason: string
      refunded_by: string
    }>(await refund(app.id, sale.id, { reason: 'withdrawal' }))

    expect(refunded.status).toBe('refunded')
    expect(refunded.refunded_amount).toBe(4990)
    expect(refunded.refund_reason).toBe('withdrawal')
    expect(refunded.refunded_by).toBe('fran@franciscosolis.cl')
    expect(sent).toHaveBeenCalledTimes(1)

    const [entry] = await readAuditLog()
    expect(entry.event).toBe('sale.refunded')
    expect(entry.metadata).toMatchObject({ reason: 'withdrawal', amount: 4990 })
  })

  it('asks MercadoPago for a card sale, and records the provider\'s refund id', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    const sale = await seedPurchase({
      applicationId: app.id,
      applicationSlug: app.slug,
      paymentId: '12345',
      environment: 'sandbox',
    })

    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return Response.json({ id: 'refund-1', status: 'approved' })
    })

    const refunded = await data<{ refund_id: string }>(await refund(app.id, sale.id, { reason: 'duplicate' }))

    expect(refunded.refund_id).toBe('refund-1')
    expect(calls[0]?.url).toBe('https://api.mercadopago.com/v1/payments/12345/refunds')
    // Keyed on the purchase and the amount, so a double-click is one refund at the provider.
    expect((calls[0]?.init?.headers as Record<string, string>)['X-Idempotency-Key']).toContain(sale.id)
  })

  /**
   * The row is written second on purpose: a sale marked refunded for money that never moved is a
   * buyer with no download who is still out of pocket.
   */
  it('leaves the sale approved when the provider refuses', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    const sale = await seedPurchase({
      applicationId: app.id,
      applicationSlug: app.slug,
      paymentId: '12345',
      environment: 'sandbox',
    })
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 400 }))

    expect((await refund(app.id, sale.id, { reason: 'other' })).status).toBe(502)

    const rows = await data<{ status: string }[]>(await admin(`/applications/${app.id}/sales`))
    expect(rows[0]?.status).toBe('approved')
  })

  it('refuses a sale taken in the other environment', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    // The suite runs as `sandbox`; this row says the money went to the live account.
    const sale = await seedPurchase({ applicationId: app.id, applicationSlug: app.slug, environment: 'live' })

    const response = await refund(app.id, sale.id, { reason: 'withdrawal' })

    expect(response.status).toBe(409)
    expect((await body<{ error: string }>(response)).error).toContain('live')
  })

  /**
   * Should not happen — an approved payment always carries an id — but marking a sale refunded
   * without asking the provider would record money as returned that nobody returned.
   */
  it('refuses a card sale with no provider payment id', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    const sale = await seedPurchase({
      applicationId: app.id,
      applicationSlug: app.slug,
      paymentId: null,
      environment: 'sandbox',
    })

    expect((await refund(app.id, sale.id, { reason: 'other' })).status).toBe(409)
  })

  it('refuses a sale that is not approved', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    const sale = await seedPurchase({
      applicationId: app.id,
      applicationSlug: app.slug,
      status: 'pending',
      approvedAt: null,
      environment: 'sandbox',
    })

    expect((await refund(app.id, sale.id, { reason: 'withdrawal' })).status).toBe(409)
  })

  it('refuses a refund larger than the sale', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    const sale = await seedPurchase({
      applicationId: app.id,
      applicationSlug: app.slug,
      source: 'cash',
      provider: 'manual',
      environment: 'sandbox',
    })

    expect((await refund(app.id, sale.id, { reason: 'other', amount: 9999 })).status).toBe(422)
  })

  it('ends the entitlement it was granting', async () => {
    const app = await seedApplication({ slug: 'openbattery', pricingMode: 'paid', priceAmount: 4990 })
    const sale = await seedPurchase({
      applicationId: app.id,
      applicationSlug: app.slug,
      source: 'cash',
      provider: 'manual',
      environment: 'sandbox',
    })
    await refund(app.id, sale.id, { reason: 'withdrawal', notify: false })

    const access = await data<{ can_download: boolean }>(
      await SELF.fetch('https://pages.test/applications/openbattery/access', { headers: await asBuyer() }),
    )

    expect(access.can_download).toBe(false)
  })

  it('404s for a sale belonging to another application', async () => {
    const mine = await seedApplication({ slug: 'openbattery' })
    const other = await seedApplication({ slug: 'other' })
    const sale = await seedPurchase({ applicationId: other.id, applicationSlug: other.slug })

    expect((await refund(mine.id, sale.id, { reason: 'other' })).status).toBe(404)
  })
})

describe('PATCH /admin/applications/:applicationId/sales/:saleId', () => {
  it('corrects the address and attaches the account, and nothing else', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    const sale = await seedPurchase({
      applicationId: app.id,
      applicationSlug: app.slug,
      userId: '',
      email: 'typo@example.com',
      source: 'cash',
      provider: 'manual',
    })

    const updated = await data<{ email: string; user_id: string; linked_to_account: boolean; amount: number }>(
      await admin(`/applications/${app.id}/sales/${sale.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ email: 'Correct@example.com', user_id: 'buyer-9', amount: 1 }),
      }),
    )

    expect(updated.email).toBe('correct@example.com')
    expect(updated.user_id).toBe('buyer-9')
    expect(updated.linked_to_account).toBe(true)
    // `amount` is ignored rather than applied: correcting what was charged is a refund and a new
    // sale, not an edit.
    expect(updated.amount).toBe(4990)
  })
})

describe('GET /admin/applications/:applicationId/sales/:saleId', () => {
  it('says whether the sale can be refunded, and which rule refused it', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    const live = await seedPurchase({ applicationId: app.id, applicationSlug: app.slug, environment: 'live' })

    const detail = await data<{ refund: { refundable: boolean; reason: string | null; withdrawal_days: number } }>(
      await admin(`/applications/${app.id}/sales/${live.id}`),
    )

    expect(detail.refund.refundable).toBe(false)
    expect(detail.refund.reason).toBe('environment')
    expect(detail.refund.withdrawal_days).toBe(10)
  })
})
