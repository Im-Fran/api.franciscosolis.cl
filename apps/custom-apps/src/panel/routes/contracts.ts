import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql, type SQL } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute } from 'hono-openapi'
import * as v from 'valibot'
import { getDb, type Database } from '@/db/client'
import { apps, auditLogs, companies, contractApps, contractCycles, contracts, workLogs } from '@/db/schema'
import type { AppEnv } from '@/env'
import { BILLING_PERIODS, CONTRACTS, CURRENCIES, CYCLE_PERIODS, GRACE_ALLOWANCES, WORK_KINDS } from '@/lib/config'
import { addDays } from '@/lib/hours'
import { dayInput, optionalText, optionalUrl, paginationQuery, requiredText } from '@/lib/validation'
import { readOptionalJson, validate } from '@/lib/validate'
import { auditRow, diff, getActorContext, recordAudit } from '@/services/audit'
import {
  afterRenewal,
  CONTRACT_STATUSES,
  contractStatus,
  coveredApps,
  resolveWorkLogTarget,
  syncCycles,
  todayIn,
  toContract,
  toCycle,
  toWorkLog,
  usageOf,
  type ContractRow,
  type CycleRow,
} from '@/services/contracts'
import { assertId, dataSchema, jsonContent, listSchema, notFound, page, panelErrors } from '@/panel/shared'

/**
 * Contracts, their hours cycles and the work log (bitácora), from the panel's side.
 *
 * Hours are whole minutes on the wire as in the database, so nothing is rounded twice; the panel
 * shows them as hours. Every read of a contract first brings its cycles up to today
 * (`syncCycles`), so a cycle whose period ended reads as closed even before the cron has run.
 */
const app = new Hono<AppEnv>()

const looseSchema = v.looseObject({ id: v.string() })

/** A real calendar day: `2026-02-30` passes the pattern and is refused here. */
const calendarDay = v.pipe(
  dayInput,
  v.check((value) => {
    const [year, month, day] = value.split('-').map(Number) as [number, number, number]
    const date = new Date(Date.UTC(year, month - 1, day))
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  }, 'must be a real calendar day'),
)

const minutesInput = (max: number) => v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(max))
const moneyInput = v.pipe(v.number(), v.minValue(0), v.maxValue(1_000_000_000))
const appIdsInput = v.pipe(v.array(v.pipe(v.string(), v.uuid())), v.maxLength(100), v.transform((ids) => [...new Set(ids)]))
const graceAllowsInput = v.pipe(v.array(v.picklist(GRACE_ALLOWANCES)), v.transform((values) => [...new Set(values)].sort()))

const contractFields = {
  name: requiredText(160),
  amount: moneyInput,
  currency: v.picklist(CURRENCIES),
  billing_period: v.picklist(BILLING_PERIODS),
  starts_on: calendarDay,
  ends_on: v.nullable(calendarDay),
  auto_renew: v.boolean(),
  renewal_months: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(120)),
  notice_days: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(CONTRACTS.maxNoticeDays)),
  cycle_period: v.picklist(CYCLE_PERIODS),
  included_minutes: minutesInput(1_000_000),
  rollover_enabled: v.boolean(),
  rollover_max_minutes: v.nullable(minutesInput(1_000_000)),
  rollover_max_cycles: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(120))),
  overage_rate: moneyInput,
  grace_days: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(CONTRACTS.maxGraceDays)),
  grace_allows: graceAllowsInput,
  grace_message: v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(1000))),
  notes: v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(5000))),
  app_ids: appIdsInput,
}

const createSchema = v.object({
  company_id: v.pipe(v.string(), v.uuid()),
  name: contractFields.name,
  amount: v.optional(contractFields.amount, 0),
  currency: v.optional(contractFields.currency, 'CLP'),
  billing_period: v.optional(contractFields.billing_period, 'monthly'),
  starts_on: contractFields.starts_on,
  ends_on: v.optional(contractFields.ends_on, null),
  auto_renew: v.optional(contractFields.auto_renew, false),
  renewal_months: v.optional(contractFields.renewal_months, CONTRACTS.defaultRenewalMonths),
  notice_days: v.optional(contractFields.notice_days, CONTRACTS.defaultNoticeDays),
  cycle_period: v.optional(contractFields.cycle_period, 'monthly'),
  included_minutes: v.optional(contractFields.included_minutes, 0),
  rollover_enabled: v.optional(contractFields.rollover_enabled, false),
  rollover_max_minutes: v.optional(contractFields.rollover_max_minutes, null),
  rollover_max_cycles: v.optional(contractFields.rollover_max_cycles, null),
  overage_rate: v.optional(contractFields.overage_rate, 0),
  grace_days: v.optional(contractFields.grace_days, 0),
  grace_allows: v.optional(contractFields.grace_allows, []),
  grace_message: v.optional(contractFields.grace_message, null),
  notes: v.optional(contractFields.notes, null),
  app_ids: v.optional(contractFields.app_ids, []),
})

const patchSchema = v.object(Object.fromEntries(Object.entries(contractFields).map(([key, schema]) => [key, v.optional(schema)])) as {
  [K in keyof typeof contractFields]: v.OptionalSchema<(typeof contractFields)[K], undefined>
})

const loadContract = async (db: Database, id: string) => {
  const [row] = await db.select().from(contracts).where(eq(contracts.id, id)).limit(1)
  if (!row) throw notFound('Contract')
  return row
}

const companyOf = async (db: Database, id: string) => {
  const [row] = await db.select({ id: companies.id, legal_name: companies.legalName, trade_name: companies.tradeName }).from(companies).where(eq(companies.id, id)).limit(1)
  return row ?? null
}

/** Refuses apps that are not the company's, or that another contract already covers in the same dates. */
const checkApps = async (db: Database, input: { companyId: string; appIds: string[]; startsOn: string; endsOn: string | null; exceptContractId?: string }) => {
  if (input.appIds.length === 0) return
  const owned = await db.select({ id: apps.id }).from(apps).where(and(eq(apps.companyId, input.companyId), inArray(apps.id, input.appIds)))
  if (owned.length !== input.appIds.length) throw new HTTPException(422, { message: "app_ids must all be apps of the contract's company" })
  const others = await db
    .select({ contract: contracts, appId: contractApps.appId, appName: apps.name })
    .from(contractApps)
    .innerJoin(contracts, eq(contracts.id, contractApps.contractId))
    .innerJoin(apps, eq(apps.id, contractApps.appId))
    .where(and(inArray(contractApps.appId, input.appIds), isNull(contracts.cancelledAt), input.exceptContractId ? ne(contracts.id, input.exceptContractId) : undefined))
  const clash = others.find(
    ({ contract }) => contract.startsOn <= (input.endsOn ?? '9999-12-31') && input.startsOn <= (contract.endsOn ?? '9999-12-31'),
  )
  if (clash) throw new HTTPException(409, { message: `${clash.appName} is already covered by “${clash.contract.name}” in those dates` })
}

const checkDates = (startsOn: string, endsOn: string | null) => {
  if (endsOn && endsOn < startsOn) throw new HTTPException(400, { message: 'ends_on: cannot be before starts_on' })
}

/** A contract as the detail view shows it: company, apps, and the cycle running today with per-app usage. */
const detail = async (db: Database, row: ContractRow, day: string) => {
  await syncCycles(db, row, day)
  const fresh = await loadContract(db, row.id)
  const [company, covered, [current]] = await Promise.all([
    companyOf(db, fresh.companyId),
    coveredApps(db, [fresh.id]),
    db.select().from(contractCycles).where(and(eq(contractCycles.contractId, fresh.id), eq(contractCycles.status, 'open'))).orderBy(desc(contractCycles.startsOn)).limit(1),
  ])
  let currentCycle = null
  let usageByApp: Array<{ app_id: string | null; app_name: string | null; minutes: number }> = []
  if (current) {
    const used = (await usageOf(db, [current.id])).get(current.id) ?? 0
    currentCycle = toCycle(current, used, fresh)
    usageByApp = (
      await db
        .select({ appId: workLogs.appId, appName: apps.name, minutes: sql<number>`SUM(${workLogs.minutes})` })
        .from(workLogs)
        .leftJoin(apps, eq(apps.id, workLogs.appId))
        .where(eq(workLogs.cycleId, current.id))
        .groupBy(workLogs.appId, apps.name)
    ).map((entry) => ({ app_id: entry.appId, app_name: entry.appName, minutes: Number(entry.minutes) }))
  }
  return { ...toContract(fresh, { day, company, apps: covered.get(fresh.id) ?? [], currentCycle }), current_cycle_usage_by_app: usageByApp }
}

/* ── Contracts ─────────────────────────────────────────────────────────────── */

app.get(
  '/contracts',
  describeRoute({
    description: 'Contracts, ending soonest first (open-ended last), with their status, covered apps and the cycle running today.',
    tags: ['Contracts'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The contracts', content: jsonContent(listSchema(looseSchema)) }, ...panelErrors },
  }),
  validate(
    'query',
    v.object({
      company_id: v.optional(v.pipe(v.string(), v.uuid())),
      app_id: v.optional(v.pipe(v.string(), v.uuid())),
      status: v.optional(v.picklist(CONTRACT_STATUSES)),
      ...paginationQuery,
    }),
  ),
  async (c) => {
    const query = c.req.valid('query')
    const { limit, offset } = page(query)
    const db = getDb(c.env)
    const day = todayIn()
    const conditions: SQL[] = []
    if (query.company_id) conditions.push(eq(contracts.companyId, query.company_id))
    if (query.app_id) conditions.push(sql`EXISTS (SELECT 1 FROM contract_apps x WHERE x.contract_id = ${contracts.id} AND x.app_id = ${query.app_id})`)
    let rows = await db
      .select({ contract: contracts, companyId: companies.id, legalName: companies.legalName, tradeName: companies.tradeName })
      .from(contracts)
      .innerJoin(companies, eq(companies.id, contracts.companyId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(sql`${contracts.endsOn} IS NULL`, asc(contracts.endsOn), asc(contracts.name))
    if (query.status) rows = rows.filter((row) => contractStatus(row.contract, day) === query.status)
    const pageRows = rows.slice(offset, offset + limit)
    for (const row of pageRows) await syncCycles(db, row.contract, day)
    const ids = pageRows.map((row) => row.contract.id)
    const [covered, cycles] = await Promise.all([
      coveredApps(db, ids),
      ids.length > 0 ? db.select().from(contractCycles).where(and(inArray(contractCycles.contractId, ids), eq(contractCycles.status, 'open'))) : Promise.resolve([] as CycleRow[]),
    ])
    const usage = await usageOf(db, cycles.map((cycle) => cycle.id))
    const cycleOf = new Map(cycles.map((cycle) => [cycle.contractId, cycle]))
    return c.json({
      code: 200 as const,
      data: pageRows.map((row) => {
        const cycle = cycleOf.get(row.contract.id)
        return toContract(row.contract, {
          day,
          company: { id: row.companyId, legal_name: row.legalName, trade_name: row.tradeName },
          apps: covered.get(row.contract.id) ?? [],
          currentCycle: cycle ? toCycle(cycle, usage.get(cycle.id) ?? 0, row.contract) : null,
        })
      }),
      pagination: { limit, offset, total: rows.length },
    })
  },
)

app.post(
  '/contracts',
  describeRoute({
    description:
      'Creates a contract for a company, covering some of its apps. An app may be covered by successive contracts but never by two in the same dates. Hours are in minutes; `ends_on` is the last day covered (null for open-ended).',
    tags: ['Contracts'],
    security: [{ bearerAuth: [] }],
    responses: { 201: { description: 'Created', content: jsonContent(dataSchema(looseSchema, 201)) }, 409: { description: 'An app is already covered in those dates' }, 422: { description: 'Unknown company or app' }, ...panelErrors },
  }),
  validate('json', createSchema),
  async (c) => {
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    if (!(await companyOf(db, body.company_id))) throw new HTTPException(422, { message: 'Unknown company' })
    checkDates(body.starts_on, body.ends_on)
    await checkApps(db, { companyId: body.company_id, appIds: body.app_ids, startsOn: body.starts_on, endsOn: body.ends_on })
    const id = crypto.randomUUID()
    await db.batch([
      db.insert(contracts).values({
        id,
        companyId: body.company_id,
        name: body.name,
        amount: body.amount,
        currency: body.currency,
        billingPeriod: body.billing_period,
        startsOn: body.starts_on,
        endsOn: body.ends_on,
        autoRenew: body.auto_renew,
        renewalMonths: body.renewal_months,
        noticeDays: body.notice_days,
        cyclePeriod: body.cycle_period,
        includedMinutes: body.included_minutes,
        rolloverEnabled: body.rollover_enabled,
        rolloverMaxMinutes: body.rollover_max_minutes,
        rolloverMaxCycles: body.rollover_max_cycles,
        overageRate: body.overage_rate,
        graceDays: body.grace_days,
        graceAllows: JSON.stringify(body.grace_allows),
        graceMessage: body.grace_message || null,
        notes: body.notes || null,
        createdBy: actor.actorEmail,
        updatedBy: actor.actorEmail,
      }),
      ...body.app_ids.map((appId) => db.insert(contractApps).values({ contractId: id, appId })),
    ])
    const data = await detail(db, await loadContract(db, id), todayIn())
    await recordAudit(db, { event: 'contract.created', resourceType: 'contract', resourceId: id, ...actor, metadata: { after: data } })
    return c.json({ code: 201 as const, data }, 201)
  },
)

app.get(
  '/contracts/:contractId',
  describeRoute({
    description: 'One contract: status, covered apps, and the cycle running today with its balance and usage per app.',
    tags: ['Contracts'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The contract', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('contractId'), 'Contract')
    const db = getDb(c.env)
    return c.json({ code: 200 as const, data: await detail(db, await loadContract(db, id), todayIn()) })
  },
)

/**
 * Applies an edit of `ends_on` that may renew a lapsed contract: the apps its lapse switched off come
 * back, and it can be warned about again before its new end.
 */
const editContract = async (c: Context<AppEnv>, before: ContractRow, body: v.InferOutput<typeof patchSchema>, event: 'contract.updated' | 'contract.renewed') => {
  const actor = getActorContext(c)
  const db = getDb(c.env)
  const day = todayIn()
  const startsOn = body.starts_on ?? before.startsOn
  const endsOn = body.ends_on !== undefined ? body.ends_on : before.endsOn
  checkDates(startsOn, endsOn)
  const [firstCycle] = await db.select().from(contractCycles).where(eq(contractCycles.contractId, before.id)).orderBy(asc(contractCycles.startsOn)).limit(1)
  if (firstCycle && ((body.starts_on !== undefined && body.starts_on !== before.startsOn) || (body.cycle_period !== undefined && body.cycle_period !== before.cyclePeriod))) {
    throw new HTTPException(409, { message: 'starts_on and cycle_period cannot change once a cycle exists: the cycles are anchored on them' })
  }
  if (endsOn) {
    const [later] = await db.select({ id: contractCycles.id }).from(contractCycles).where(and(eq(contractCycles.contractId, before.id), sql`${contractCycles.startsOn} > ${endsOn}`)).limit(1)
    if (later) throw new HTTPException(409, { message: 'ends_on: a cycle already starts after that day' })
  }
  const appIds = body.app_ids
  if (appIds) await checkApps(db, { companyId: before.companyId, appIds, startsOn, endsOn, exceptContractId: before.id })
  else if (body.starts_on !== undefined || body.ends_on !== undefined) {
    const current = ((await coveredApps(db, [before.id])).get(before.id) ?? []).map((entry) => entry.id)
    await checkApps(db, { companyId: before.companyId, appIds: current, startsOn, endsOn, exceptContractId: before.id })
  }
  const beforeView = await detail(db, before, day)
  const now = new Date()
  await db.batch([
    db
      .update(contracts)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.amount !== undefined && { amount: body.amount }),
        ...(body.currency !== undefined && { currency: body.currency }),
        ...(body.billing_period !== undefined && { billingPeriod: body.billing_period }),
        ...(body.starts_on !== undefined && { startsOn: body.starts_on }),
        ...(body.ends_on !== undefined && { endsOn: body.ends_on }),
        ...(body.auto_renew !== undefined && { autoRenew: body.auto_renew }),
        ...(body.renewal_months !== undefined && { renewalMonths: body.renewal_months }),
        ...(body.notice_days !== undefined && { noticeDays: body.notice_days }),
        ...(body.cycle_period !== undefined && { cyclePeriod: body.cycle_period }),
        ...(body.included_minutes !== undefined && { includedMinutes: body.included_minutes }),
        ...(body.rollover_enabled !== undefined && { rolloverEnabled: body.rollover_enabled }),
        ...(body.rollover_max_minutes !== undefined && { rolloverMaxMinutes: body.rollover_max_minutes }),
        ...(body.rollover_max_cycles !== undefined && { rolloverMaxCycles: body.rollover_max_cycles }),
        ...(body.overage_rate !== undefined && { overageRate: body.overage_rate }),
        ...(body.grace_days !== undefined && { graceDays: body.grace_days }),
        ...(body.grace_allows !== undefined && { graceAllows: JSON.stringify(body.grace_allows) }),
        ...(body.grace_message !== undefined && { graceMessage: body.grace_message || null }),
        ...(body.notes !== undefined && { notes: body.notes || null }),
        updatedBy: actor.actorEmail,
        updatedAt: now,
      })
      .where(eq(contracts.id, before.id)),
    ...(appIds ? [db.delete(contractApps).where(eq(contractApps.contractId, before.id)), ...appIds.map((appId) => db.insert(contractApps).values({ contractId: before.id, appId }))] : []),
  ])
  let after = await loadContract(db, before.id)
  let reactivated: string[] = []
  if (after.endsOn !== before.endsOn || after.autoRenew !== before.autoRenew) {
    reactivated = await afterRenewal(c.env, db, after, actor, now)
    after = await loadContract(db, before.id)
  }
  const afterView = await detail(db, after, day)
  await recordAudit(db, { event, resourceType: 'contract', resourceId: before.id, ...actor, metadata: { ...diff(beforeView, afterView), reactivated_apps: reactivated } })
  return afterView
}

app.patch(
  '/contracts/:contractId',
  describeRoute({
    description:
      'Edits a contract. `app_ids` replaces the covered apps. Moving `ends_on` later on a contract that already lapsed renews it: the apps its lapse put in grace or suspended are reactivated. `starts_on` and `cycle_period` are fixed once a cycle exists.',
    tags: ['Contracts'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Updated', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, 409: { description: 'Conflicts with existing cycles or another contract' }, ...panelErrors },
  }),
  validate('json', patchSchema),
  async (c) => {
    const id = assertId(c.req.param('contractId'), 'Contract')
    const before = await loadContract(getDb(c.env), id)
    if (before.cancelledAt) throw new HTTPException(409, { message: 'A cancelled contract cannot be edited' })
    return c.json({ code: 200 as const, data: await editContract(c, before, c.req.valid('json'), 'contract.updated') })
  },
)

app.post(
  '/contracts/:contractId/renew',
  describeRoute({
    description: 'Renews a contract until `ends_on` (or open-ended with null). Reactivates the apps a lapse put in grace or suspended, ends the notices it posted, and lets the client be warned again before the new end.',
    tags: ['Contracts'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Renewed', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, 409: { description: 'Cancelled, or not later than the current end' }, ...panelErrors },
  }),
  validate('json', v.object({ ends_on: v.nullable(calendarDay) })),
  async (c) => {
    const id = assertId(c.req.param('contractId'), 'Contract')
    const { ends_on: endsOn } = c.req.valid('json')
    const before = await loadContract(getDb(c.env), id)
    if (before.cancelledAt) throw new HTTPException(409, { message: 'A cancelled contract cannot be renewed; create a new one' })
    if (endsOn && before.endsOn && endsOn <= before.endsOn) throw new HTTPException(409, { message: 'ends_on: a renewal has to end later than the contract does now' })
    if (endsOn && endsOn < todayIn()) throw new HTTPException(409, { message: 'ends_on: a renewal has to reach today at least' })
    return c.json({ code: 200 as const, data: await editContract(c, before, { ends_on: endsOn }, 'contract.renewed') })
  },
)

app.post(
  '/contracts/:contractId/cancel',
  describeRoute({
    description:
      'Cancels a contract from today: no new cycles start, nothing more is sent about it, and its apps are left as they are — use the kill switch to suspend them. The cycle running today closes at its normal end.',
    tags: ['Contracts'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Cancelled', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, 409: { description: 'Already cancelled' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('contractId'), 'Contract')
    const { reason } = await readOptionalJson(c, v.object({ reason: optionalText(500) }))
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadContract(db, id)
    if (before.cancelledAt) throw new HTTPException(409, { message: 'This contract is already cancelled' })
    const now = new Date()
    await db.batch([
      db.update(contracts).set({ cancelledAt: now, cancelledBy: actor.actorEmail, updatedAt: now, updatedBy: actor.actorEmail }).where(eq(contracts.id, id)),
      db.insert(auditLogs).values(
        auditRow({ event: 'contract.cancelled', resourceType: 'contract', resourceId: id, ...actor, metadata: { reason: reason ?? null } }),
      ),
    ])
    return c.json({ code: 200 as const, data: await detail(db, await loadContract(db, id), todayIn()) })
  },
)

app.delete(
  '/contracts/:contractId',
  describeRoute({
    description: 'Deletes a contract that nothing was ever billed against: no closed cycle and no work logged. Anything else is history — cancel it instead.',
    tags: ['Contracts'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' }, 409: { description: 'It has history' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('contractId'), 'Contract')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadContract(db, id)
    const [[closed], [logged]] = await Promise.all([
      db.select({ count: sql<number>`COUNT(*)` }).from(contractCycles).where(and(eq(contractCycles.contractId, id), ne(contractCycles.status, 'open'))),
      db.select({ count: sql<number>`COUNT(*)` }).from(workLogs).where(eq(workLogs.contractId, id)),
    ])
    if (Number(closed?.count ?? 0) > 0 || Number(logged?.count ?? 0) > 0) {
      throw new HTTPException(409, { message: 'This contract has closed cycles or logged work; cancel it instead of deleting it' })
    }
    await db.delete(contracts).where(eq(contracts.id, id))
    await recordAudit(db, { event: 'contract.deleted', resourceType: 'contract', resourceId: id, ...actor, metadata: { before: toContract(before, { day: todayIn() }) } })
    return c.json({ code: 200 as const, data: { id, deleted: true } })
  },
)

/* ── Cycles ────────────────────────────────────────────────────────────────── */

app.get(
  '/contracts/:contractId/cycles',
  describeRoute({
    description: "A contract's cycles, newest first: included, carried, used, left, overage and its price, expired hours, and whether it was billed.",
    tags: ['Contracts'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The cycles', content: jsonContent(listSchema(looseSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('query', v.object(paginationQuery)),
  async (c) => {
    const id = assertId(c.req.param('contractId'), 'Contract')
    const { limit, offset } = page(c.req.valid('query'))
    const db = getDb(c.env)
    const contract = await loadContract(db, id)
    await syncCycles(db, contract, todayIn())
    const [rows, [total]] = await Promise.all([
      db.select().from(contractCycles).where(eq(contractCycles.contractId, id)).orderBy(desc(contractCycles.startsOn)).limit(limit).offset(offset),
      db.select({ count: sql<number>`COUNT(*)` }).from(contractCycles).where(eq(contractCycles.contractId, id)),
    ])
    const usage = await usageOf(db, rows.map((row) => row.id))
    return c.json({ code: 200 as const, data: rows.map((row) => toCycle(row, usage.get(row.id) ?? 0, contract)), pagination: { limit, offset, total: Number(total?.count ?? 0) } })
  },
)

const loadCycle = async (db: Database, id: string) => {
  const [row] = await db.select({ cycle: contractCycles, contract: contracts }).from(contractCycles).innerJoin(contracts, eq(contracts.id, contractCycles.contractId)).where(eq(contractCycles.id, id)).limit(1)
  if (!row) throw notFound('Cycle')
  return row
}

const workLogSelection = { log: workLogs, appName: apps.name, companyName: companies.legalName, contractName: contracts.name, cycleStatus: contractCycles.status }

const workLogQuery = (db: Database) =>
  db
    .select(workLogSelection)
    .from(workLogs)
    .innerJoin(companies, eq(companies.id, workLogs.companyId))
    .leftJoin(apps, eq(apps.id, workLogs.appId))
    .leftJoin(contracts, eq(contracts.id, workLogs.contractId))
    .leftJoin(contractCycles, eq(contractCycles.id, workLogs.cycleId))

type WorkLogSelection = { log: typeof workLogs.$inferSelect; appName: string | null; companyName: string; contractName: string | null; cycleStatus: string | null }
const serializeLog = (row: WorkLogSelection) => toWorkLog(row.log, row)

app.get(
  '/cycles/:cycleId',
  describeRoute({
    description: 'One cycle with its balance and every work log entry filed under it.',
    tags: ['Contracts'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The cycle', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('cycleId'), 'Cycle')
    const db = getDb(c.env)
    const { contract } = await loadCycle(db, id)
    await syncCycles(db, contract, todayIn())
    const { cycle } = await loadCycle(db, id)
    const [usage, logs] = await Promise.all([usageOf(db, [id]), workLogQuery(db).where(eq(workLogs.cycleId, id)).orderBy(desc(workLogs.occurredOn), desc(workLogs.createdAt))])
    return c.json({ code: 200 as const, data: { ...toCycle(cycle, usage.get(id) ?? 0, contract), contract: { id: contract.id, name: contract.name, currency: contract.currency, overage_rate: contract.overageRate }, work_logs: logs.map(serializeLog) } })
  },
)

app.post(
  '/cycles/:cycleId/close',
  describeRoute({
    description: 'Closes a cycle whose period has ended, now rather than on the next cron run. A cycle still running cannot be closed: its period is fixed by the contract.',
    tags: ['Contracts'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Closed', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, 409: { description: 'Still running, or already closed' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('cycleId'), 'Cycle')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const { cycle, contract } = await loadCycle(db, id)
    const day = todayIn()
    if (cycle.status !== 'open') throw new HTTPException(409, { message: 'This cycle is already closed' })
    if (cycle.endsOn > day) throw new HTTPException(409, { message: `This cycle runs until ${addDays(cycle.endsOn, -1)}; it closes on its own after that` })
    await syncCycles(db, contract, day, actor.actorEmail)
    const after = await loadCycle(db, id)
    const usage = await usageOf(db, [id])
    return c.json({ code: 200 as const, data: toCycle(after.cycle, usage.get(id) ?? 0, contract) })
  },
)

app.post(
  '/cycles/:cycleId/bill',
  describeRoute({
    description: "Marks a closed cycle's overage as charged, with a reference to where (an invoice number). It is what the panel's \"to bill\" list counts down.",
    tags: ['Contracts'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Billed', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, 409: { description: 'Not closed' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('cycleId'), 'Cycle')
    const { reference } = await readOptionalJson(c, v.object({ reference: optionalText(200) }))
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const { cycle, contract } = await loadCycle(db, id)
    if (cycle.status !== 'closed') throw new HTTPException(409, { message: cycle.status === 'billed' ? 'This cycle is already billed' : 'Only a closed cycle can be billed' })
    const now = new Date()
    const [updated] = await db
      .update(contractCycles)
      .set({ status: 'billed', billedAt: now, billedBy: actor.actorEmail, billingReference: reference ?? null, updatedAt: now })
      .where(and(eq(contractCycles.id, id), eq(contractCycles.status, 'closed')))
      .returning()
    if (!updated) throw new HTTPException(409, { message: 'The cycle changed while saving; reload and try again' })
    await recordAudit(db, { event: 'cycle.billed', resourceType: 'contract', resourceId: contract.id, ...actor, metadata: { cycle_id: id, reference: reference ?? null, overage_amount: updated.overageAmount, currency: contract.currency } })
    return c.json({ code: 200 as const, data: toCycle(updated, updated.usedMinutes ?? 0, contract) })
  },
)

/* ── Work log ──────────────────────────────────────────────────────────────── */

const workLogFilters = v.object({
  company_id: v.optional(v.pipe(v.string(), v.uuid())),
  app_id: v.optional(v.pipe(v.string(), v.uuid())),
  contract_id: v.optional(v.pipe(v.string(), v.uuid())),
  cycle_id: v.optional(v.pipe(v.string(), v.uuid())),
  kind: v.optional(v.picklist(WORK_KINDS)),
  from: v.optional(calendarDay),
  to: v.optional(calendarDay),
  ...paginationQuery,
})

const listWorkLogs = async (c: Context<AppEnv>, query: v.InferOutput<typeof workLogFilters>) => {
  const { limit, offset } = page(query)
  const db = getDb(c.env)
  const where = and(
    query.company_id ? eq(workLogs.companyId, query.company_id) : undefined,
    query.app_id ? eq(workLogs.appId, query.app_id) : undefined,
    query.contract_id ? eq(workLogs.contractId, query.contract_id) : undefined,
    query.cycle_id ? eq(workLogs.cycleId, query.cycle_id) : undefined,
    query.kind ? eq(workLogs.kind, query.kind) : undefined,
    query.from ? gte(workLogs.occurredOn, query.from) : undefined,
    query.to ? lte(workLogs.occurredOn, query.to) : undefined,
  )
  const [rows, [totals]] = await Promise.all([
    workLogQuery(db).where(where).orderBy(desc(workLogs.occurredOn), desc(workLogs.createdAt)).limit(limit).offset(offset),
    db.select({ count: sql<number>`COUNT(*)`, minutes: sql<number>`COALESCE(SUM(${workLogs.minutes}), 0)` }).from(workLogs).where(where),
  ])
  return { code: 200 as const, data: rows.map(serializeLog), totals: { minutes: Number(totals?.minutes ?? 0) }, pagination: { limit, offset, total: Number(totals?.count ?? 0) } }
}

const workLogBody = {
  occurred_on: calendarDay,
  minutes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(CONTRACTS.maxWorkLogMinutes)),
  kind: v.picklist(WORK_KINDS),
  description: requiredText(2000),
  link_url: optionalUrl,
}

const createWorkLogSchema = v.object({
  company_id: v.optional(v.pipe(v.string(), v.uuid())),
  app_id: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))),
  contract_id: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))),
  ...workLogBody,
})

const createWorkLog = async (c: Context<AppEnv>, body: v.InferOutput<typeof createWorkLogSchema>) => {
  const actor = getActorContext(c)
  const db = getDb(c.env)
  let companyId = body.company_id ?? null
  if (body.app_id) {
    const [appRow] = await db.select({ companyId: apps.companyId }).from(apps).where(eq(apps.id, body.app_id)).limit(1)
    if (!appRow) throw new HTTPException(422, { message: 'Unknown app' })
    if (companyId && companyId !== appRow.companyId) throw new HTTPException(422, { message: 'app_id belongs to another company' })
    companyId = appRow.companyId
  }
  if (!companyId) throw new HTTPException(400, { message: 'company_id or app_id is required' })
  if (!(await companyOf(db, companyId))) throw new HTTPException(422, { message: 'Unknown company' })
  const target = await resolveWorkLogTarget(db, { companyId, appId: body.app_id ?? null, contractId: body.contract_id, occurredOn: body.occurred_on, day: todayIn() })
  const id = crypto.randomUUID()
  await db.insert(workLogs).values({
    id,
    companyId,
    appId: body.app_id ?? null,
    contractId: target.contractId,
    cycleId: target.cycleId,
    occurredOn: body.occurred_on,
    minutes: body.minutes,
    kind: body.kind,
    description: body.description,
    linkUrl: body.link_url ?? null,
    createdBy: actor.actorEmail,
    updatedBy: actor.actorEmail,
  })
  const [row] = await workLogQuery(db).where(eq(workLogs.id, id))
  const data = serializeLog(row!)
  await recordAudit(db, { event: 'work_log.created', resourceType: 'company', resourceId: companyId, ...actor, metadata: { work_log_id: id, after: data } })
  return data
}

const workLogListDoc = (scope: string) =>
  describeRoute({
    description: `The work log ${scope}, newest first, with the total minutes of everything the filters match.`,
    tags: ['Work log'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The entries', content: jsonContent(listSchema(looseSchema)) }, ...panelErrors },
  })

const workLogCreateDoc = describeRoute({
  description:
    'Logs work. It is filed under the contract covering the app (or the company) on that day and the cycle the day falls in; `contract_id` chooses when several contracts cover it. A day inside a closed cycle is refused — its balance is final — and so is a day in the future.',
  tags: ['Work log'],
  security: [{ bearerAuth: [] }],
  responses: { 201: { description: 'Logged', content: jsonContent(dataSchema(looseSchema, 201)) }, 409: { description: 'The day is in a closed cycle' }, 422: { description: 'Unknown company, app or contract' }, ...panelErrors },
})

app.get('/work-logs', workLogListDoc('across every client'), validate('query', workLogFilters), async (c) => c.json(await listWorkLogs(c, c.req.valid('query'))))

app.post('/work-logs', workLogCreateDoc, validate('json', createWorkLogSchema), async (c) => c.json({ code: 201 as const, data: await createWorkLog(c, c.req.valid('json')) }, 201))

app.get('/apps/:appId/work-logs', workLogListDoc('of one app'), validate('query', v.omit(workLogFilters, ['app_id'])), async (c) => {
  const appId = assertId(c.req.param('appId'), 'App')
  return c.json(await listWorkLogs(c, { ...c.req.valid('query'), app_id: appId }))
})

app.post('/apps/:appId/work-logs', workLogCreateDoc, validate('json', v.omit(createWorkLogSchema, ['app_id', 'company_id'])), async (c) => {
  const appId = assertId(c.req.param('appId'), 'App')
  return c.json({ code: 201 as const, data: await createWorkLog(c, { ...c.req.valid('json'), app_id: appId }) }, 201)
})

const loadWorkLog = async (db: Database, id: string) => {
  const [row] = await workLogQuery(db).where(eq(workLogs.id, id)).limit(1)
  if (!row) throw notFound('Work log entry')
  if (row.log.cycleId && row.cycleStatus !== 'open') throw new HTTPException(409, { message: 'This entry belongs to a closed cycle; its balance is final' })
  return row
}

app.patch(
  '/work-logs/:workLogId',
  describeRoute({
    description: 'Edits an entry while its cycle is open. Changing the day or the app files it again, under whichever contract and cycle then apply.',
    tags: ['Work log'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Updated', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, 409: { description: 'In a closed cycle' }, ...panelErrors },
  }),
  validate('json', v.object({ ...Object.fromEntries(Object.entries(workLogBody).map(([key, schema]) => [key, v.optional(schema)])), app_id: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))), contract_id: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))) }) as unknown as v.GenericSchema<
    unknown,
    Partial<v.InferOutput<typeof createWorkLogSchema>>
  >),
  async (c) => {
    const id = assertId(c.req.param('workLogId'), 'Work log entry')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadWorkLog(db, id)
    const appId = body.app_id !== undefined ? body.app_id : before.log.appId
    if (appId && appId !== before.log.appId) {
      const [appRow] = await db.select({ companyId: apps.companyId }).from(apps).where(eq(apps.id, appId)).limit(1)
      if (!appRow || appRow.companyId !== before.log.companyId) throw new HTTPException(422, { message: 'app_id must be an app of the same company' })
    }
    const occurredOn = body.occurred_on ?? before.log.occurredOn
    const refile = body.occurred_on !== undefined || body.app_id !== undefined || body.contract_id !== undefined
    const target = refile
      ? await resolveWorkLogTarget(db, { companyId: before.log.companyId, appId, contractId: body.contract_id !== undefined ? body.contract_id : null, occurredOn, day: todayIn() })
      : { contractId: before.log.contractId, cycleId: before.log.cycleId }
    await db
      .update(workLogs)
      .set({
        appId,
        contractId: target.contractId,
        cycleId: target.cycleId,
        occurredOn,
        ...(body.minutes !== undefined && { minutes: body.minutes }),
        ...(body.kind !== undefined && { kind: body.kind }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.link_url !== undefined && { linkUrl: body.link_url }),
        updatedBy: actor.actorEmail,
        updatedAt: new Date(),
      })
      .where(eq(workLogs.id, id))
    const [after] = await workLogQuery(db).where(eq(workLogs.id, id))
    const data = serializeLog(after!)
    await recordAudit(db, { event: 'work_log.updated', resourceType: 'company', resourceId: before.log.companyId, ...actor, metadata: { work_log_id: id, ...diff(serializeLog(before), data) } })
    return c.json({ code: 200 as const, data })
  },
)

app.delete(
  '/work-logs/:workLogId',
  describeRoute({
    description: 'Deletes an entry while its cycle is open.',
    tags: ['Work log'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' }, 409: { description: 'In a closed cycle' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('workLogId'), 'Work log entry')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadWorkLog(db, id)
    await db.delete(workLogs).where(eq(workLogs.id, id))
    await recordAudit(db, { event: 'work_log.deleted', resourceType: 'company', resourceId: before.log.companyId, ...actor, metadata: { work_log_id: id, before: serializeLog(before) } })
    return c.json({ code: 200 as const, data: { id, deleted: true } })
  },
)

export default app
