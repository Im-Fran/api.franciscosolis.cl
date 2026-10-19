import { renderContractNoticeEmail } from '@franciscosolis/emails'
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { getDb, type Database } from '@/db/client'
import { apps, auditLogs, companies, companyContacts, contacts, contractApps, contractCycles, contracts, messages, workLogs } from '@/db/schema'
import type { Env } from '@/env'
import { CONTRACTS, type Currency, type CyclePeriod, type GraceAllowance } from '@/lib/config'
import { addDays, addMonths, carriedMinutes, closeCycle, cycleOpeningOn, daysBetween, overageAmount, type CarriedBucket, type RolloverPolicy } from '@/lib/hours'
import { iso, parseJsonArray } from '@/lib/json'
import { startOfZonedDay, zonedDay } from '@/lib/time'
import { auditRow } from '@/services/audit'
import { formatMailDay, sendMail } from '@/services/mail'
import { syncApp } from '@/services/socket'

/**
 * Contracts, their hours cycles and the work log, and what the end of a contract does to the apps it
 * covers.
 *
 * **Cycles are brought up to date lazily and by the cron alike** (`syncCycles`): whichever reads a
 * contract first after a period ends closes that cycle and opens the next. Closing computes the
 * balance once and the row is final — the next cycle's carried hours were derived from it — which is
 * why the work log refuses an entry dated inside a closed cycle.
 *
 * **The end of a contract drives the kill switch.** Before it ends the client is emailed and every
 * covered app shows a notice; once it lapses without renewal the apps go into grace (or straight to
 * suspension with no grace days), and the existing grace expiry suspends them when the grace ends.
 * Renewing reactivates what the lapse switched off. A contract that renews itself never lapses: it
 * is extended by `renewal_months` when it reaches its end.
 */

type ContractRow = typeof contracts.$inferSelect
type CycleRow = typeof contractCycles.$inferSelect
type WorkLogRow = typeof workLogs.$inferSelect

/** Today, as a Santiago calendar day. Every contract date is one. */
const todayIn = (now: Date = new Date()) => zonedDay(now)

/**
 * - `scheduled`: not started yet.
 * - `active`: running (open-ended, or not past its last day).
 * - `grace`: past its end without renewal, inside its grace days.
 * - `ended`: past its end and its grace.
 * - `cancelled`: cancelled by hand, whatever its dates say.
 */
const CONTRACT_STATUSES = ['scheduled', 'active', 'grace', 'ended', 'cancelled'] as const
type ContractStatus = (typeof CONTRACT_STATUSES)[number]

const contractStatus = (row: Pick<ContractRow, 'startsOn' | 'endsOn' | 'graceDays' | 'cancelledAt'>, day: string): ContractStatus => {
  if (row.cancelledAt) return 'cancelled'
  if (day < row.startsOn) return 'scheduled'
  if (!row.endsOn || day <= row.endsOn) return 'active'
  if (day <= addDays(row.endsOn, row.graceDays)) return 'grace'
  return 'ended'
}

/** Whether the contract covers `day`: started, not past its end, not cancelled before it. */
const covers = (row: Pick<ContractRow, 'startsOn' | 'endsOn' | 'cancelledAt'>, day: string) =>
  row.startsOn <= day && (!row.endsOn || day <= row.endsOn) && (!row.cancelledAt || day <= todayIn(row.cancelledAt))

const policyOf = (row: Pick<ContractRow, 'rolloverEnabled' | 'rolloverMaxMinutes' | 'rolloverMaxCycles'>): RolloverPolicy => ({
  enabled: row.rolloverEnabled,
  maxMinutes: row.rolloverMaxMinutes,
  maxCycles: row.rolloverMaxCycles,
})

const parseCarried = (value: string | null) => parseJsonArray<CarriedBucket>(value)

/** Minutes logged against each cycle. */
const usageOf = async (db: Database, cycleIds: string[]) => {
  if (cycleIds.length === 0) return new Map<string, number>()
  const rows = await db
    .select({ cycleId: workLogs.cycleId, minutes: sql<number>`COALESCE(SUM(${workLogs.minutes}), 0)` })
    .from(workLogs)
    .where(inArray(workLogs.cycleId, cycleIds))
    .groupBy(workLogs.cycleId)
  return new Map(rows.map((row) => [row.cycleId as string, Number(row.minutes)]))
}

/** The balance of a closed cycle, recomputed from what it stored: what the next one is carried. */
const carriedAfter = (cycle: CycleRow, contract: ContractRow) =>
  closeCycle({ startsOn: cycle.startsOn, includedMinutes: cycle.includedMinutes, carried: parseCarried(cycle.carried), usedMinutes: cycle.usedMinutes ?? 0, policy: policyOf(contract) }).carried

/** The last day new cycles may start on: the contract's end, or the day it was cancelled. */
const lastDayOf = (contract: ContractRow) => {
  const cancelled = contract.cancelledAt ? todayIn(contract.cancelledAt) : null
  if (contract.endsOn && cancelled) return contract.endsOn < cancelled ? contract.endsOn : cancelled
  return contract.endsOn ?? cancelled
}

const openCycle = async (db: Database, contract: ContractRow, startsOn: string, carried: CarriedBucket[]) => {
  const bounds = cycleOpeningOn(contract.cyclePeriod as CyclePeriod, contract.startsOn, startsOn, contract.includedMinutes, lastDayOf(contract))
  if (!bounds) return null
  await db
    .insert(contractCycles)
    .values({
      id: crypto.randomUUID(),
      contractId: contract.id,
      startsOn: bounds.startsOn,
      endsOn: bounds.endsOn,
      includedMinutes: bounds.includedMinutes,
      carried: JSON.stringify(carried),
      carriedMinutes: carriedMinutes(carried),
    })
    .onConflictDoNothing()
  const [row] = await db.select().from(contractCycles).where(and(eq(contractCycles.contractId, contract.id), eq(contractCycles.startsOn, bounds.startsOn))).limit(1)
  return row ?? null
}

/** Closes a cycle whose period ended, once: a concurrent close loses the `status = 'open'` race. */
const closeOpenCycle = async (db: Database, contract: ContractRow, cycle: CycleRow, actor: string | null, now: Date) => {
  const used = (await usageOf(db, [cycle.id])).get(cycle.id) ?? 0
  const balance = closeCycle({ startsOn: cycle.startsOn, includedMinutes: cycle.includedMinutes, carried: parseCarried(cycle.carried), usedMinutes: used, policy: policyOf(contract) })
  const [closed] = await db
    .update(contractCycles)
    .set({
      status: 'closed',
      usedMinutes: used,
      overageMinutes: balance.overageMinutes,
      overageAmount: overageAmount(balance.overageMinutes, contract.overageRate, contract.currency as Currency),
      expiredMinutes: balance.expiredMinutes,
      closedAt: now,
      closedBy: actor,
      updatedAt: now,
    })
    .where(and(eq(contractCycles.id, cycle.id), eq(contractCycles.status, 'open')))
    .returning()
  if (closed) {
    await db.insert(auditLogs).values(
      auditRow({
        event: 'cycle.closed',
        actorEmail: actor,
        resourceType: 'contract',
        resourceId: contract.id,
        metadata: { cycle_id: cycle.id, automatic: actor === null, starts_on: cycle.startsOn, ends_on: cycle.endsOn, used_minutes: used, overage_minutes: balance.overageMinutes, expired_minutes: balance.expiredMinutes },
      }),
    )
  }
  const [row] = await db.select().from(contractCycles).where(eq(contractCycles.id, cycle.id)).limit(1)
  return row!
}

/**
 * Brings a contract's cycles up to `day`: closes every cycle whose period ended and opens the one
 * that contains `day`, carrying over what the policy allows. Idempotent and safe to race: inserts
 * are keyed on the cycle's start and closes on its status.
 */
const syncCycles = async (db: Database, contract: ContractRow, day: string, actor: string | null = null, now: Date = new Date()) => {
  const [latestRow] = await db.select().from(contractCycles).where(eq(contractCycles.contractId, contract.id)).orderBy(desc(contractCycles.startsOn)).limit(1)
  let latest: CycleRow | null = latestRow ?? null
  const lastDay = lastDayOf(contract)
  for (let step = 0; step < CONTRACTS.maxCyclesPerRun; step += 1) {
    if (!latest) {
      if (day < contract.startsOn || (lastDay && contract.startsOn > lastDay)) return null
      latest = await openCycle(db, contract, contract.startsOn, [])
      if (!latest) return null
      continue
    }
    if (latest.status === 'open') {
      if (latest.endsOn > day) return latest
      latest = await closeOpenCycle(db, contract, latest, actor, now)
    }
    const nextStart = latest.endsOn
    if (nextStart > day || (lastDay && nextStart > lastDay)) return latest
    const next = await openCycle(db, contract, nextStart, carriedAfter(latest, contract))
    // A cycle that does not move past the latest one would loop until the step limit, querying D1
    // on every turn; stop instead and leave the calendar where it is.
    if (!next || next.endsOn <= latest.endsOn) return latest
    latest = next
  }
  return latest
}

/** An open cycle's running balance; a closed one's stored balance. */
const cycleBalance = (cycle: CycleRow, used: number) => {
  const available = cycle.includedMinutes + cycle.carriedMinutes
  const usedMinutes = cycle.status === 'open' ? used : (cycle.usedMinutes ?? used)
  return {
    available_minutes: available,
    used_minutes: usedMinutes,
    remaining_minutes: Math.max(0, available - usedMinutes),
    overage_minutes: cycle.status === 'open' ? Math.max(0, usedMinutes - available) : (cycle.overageMinutes ?? 0),
  }
}

const toCycle = (cycle: CycleRow, used: number, contract?: Pick<ContractRow, 'currency' | 'overageRate'>) => {
  const balance = cycleBalance(cycle, used)
  return {
    id: cycle.id,
    contract_id: cycle.contractId,
    starts_on: cycle.startsOn,
    ends_on: cycle.endsOn,
    status: cycle.status,
    included_minutes: cycle.includedMinutes,
    carried_minutes: cycle.carriedMinutes,
    carried: parseCarried(cycle.carried),
    ...balance,
    /** What the overage costs: final once closed, an estimate at the contract's rate while open. */
    overage_amount:
      cycle.status === 'open'
        ? contract
          ? overageAmount(balance.overage_minutes, contract.overageRate, contract.currency as Currency)
          : null
        : cycle.overageAmount,
    expired_minutes: cycle.expiredMinutes,
    closed_at: iso(cycle.closedAt),
    closed_by: cycle.closedBy,
    billed_at: iso(cycle.billedAt),
    billed_by: cycle.billedBy,
    billing_reference: cycle.billingReference,
  }
}

type CoveredApp = { id: string; name: string; state: string }

const coveredApps = async (db: Database, contractIds: string[]) => {
  const map = new Map<string, CoveredApp[]>()
  if (contractIds.length === 0) return map
  const rows = await db
    .select({ contractId: contractApps.contractId, id: apps.id, name: apps.name, state: apps.state })
    .from(contractApps)
    .innerJoin(apps, eq(apps.id, contractApps.appId))
    .where(inArray(contractApps.contractId, contractIds))
    .orderBy(asc(apps.name))
  for (const row of rows) map.set(row.contractId, [...(map.get(row.contractId) ?? []), { id: row.id, name: row.name, state: row.state }])
  return map
}

const toContract = (
  row: ContractRow,
  extra: { day: string; company?: { id: string; legal_name: string; trade_name: string | null } | null; apps?: CoveredApp[]; currentCycle?: ReturnType<typeof toCycle> | null },
) => {
  const status = contractStatus(row, extra.day)
  const daysLeft = row.endsOn && !row.cancelledAt ? daysBetween(extra.day, row.endsOn) : null
  return {
    id: row.id,
    company_id: row.companyId,
    company: extra.company ?? null,
    name: row.name,
    amount: row.amount,
    currency: row.currency,
    billing_period: row.billingPeriod,
    starts_on: row.startsOn,
    ends_on: row.endsOn,
    auto_renew: row.autoRenew,
    renewal_months: row.renewalMonths,
    notice_days: row.noticeDays,
    cycle_period: row.cyclePeriod,
    included_minutes: row.includedMinutes,
    rollover_enabled: row.rolloverEnabled,
    rollover_max_minutes: row.rolloverMaxMinutes,
    rollover_max_cycles: row.rolloverMaxCycles,
    overage_rate: row.overageRate,
    grace_days: row.graceDays,
    grace_allows: parseJsonArray<GraceAllowance>(row.graceAllows),
    grace_message: row.graceMessage,
    status,
    days_left: daysLeft,
    /** Ends within its notice period without renewing itself. */
    expiring: status === 'active' && !row.autoRenew && daysLeft !== null && daysLeft <= row.noticeDays,
    notice_sent_at: iso(row.noticeSentAt),
    lapsed_at: iso(row.lapsedAt),
    cancelled_at: iso(row.cancelledAt),
    cancelled_by: row.cancelledBy,
    notes: row.notes,
    apps: extra.apps ?? [],
    current_cycle: extra.currentCycle ?? null,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
    created_by: row.createdBy,
    updated_by: row.updatedBy,
  }
}

const toWorkLog = (row: WorkLogRow, extra: { appName?: string | null; companyName?: string | null; contractName?: string | null; cycleStatus?: string | null; ticketNumber?: number | null } = {}) => ({
  id: row.id,
  company_id: row.companyId,
  company_name: extra.companyName ?? null,
  app_id: row.appId,
  app_name: extra.appName ?? null,
  contract_id: row.contractId,
  contract_name: extra.contractName ?? null,
  cycle_id: row.cycleId,
  /** Whether the entry can still be edited: no cycle, or an open one. */
  editable: !row.cycleId || extra.cycleStatus === 'open',
  occurred_on: row.occurredOn,
  minutes: row.minutes,
  kind: row.kind,
  description: row.description,
  link_url: row.linkUrl,
  ticket_id: row.ticketId,
  ticket_number: extra.ticketNumber ?? null,
  created_at: iso(row.createdAt),
  updated_at: iso(row.updatedAt),
  created_by: row.createdBy,
  updated_by: row.updatedBy,
})

/**
 * Which contract and cycle a work log entry belongs to.
 *
 * Explicit `contractId` wins; otherwise the contract covering the app on that day, or — for an entry
 * about the company as a whole — the one contract covering the company. No contract is a valid
 * answer (work outside any contract); several are not, and the caller is asked to choose.
 */
const resolveWorkLogTarget = async (db: Database, input: { companyId: string; appId: string | null; contractId?: string | null; occurredOn: string; day: string }) => {
  if (input.occurredOn > input.day) throw new HTTPException(400, { message: 'occurred_on: work cannot be logged in the future' })
  let candidates: ContractRow[]
  if (input.contractId) {
    const [row] = await db.select().from(contracts).where(eq(contracts.id, input.contractId)).limit(1)
    if (!row || row.companyId !== input.companyId) throw new HTTPException(422, { message: 'contract_id must be a contract of the same company' })
    if (!covers(row, input.occurredOn)) throw new HTTPException(422, { message: 'That contract does not cover that day' })
    candidates = [row]
  } else if (input.appId) {
    candidates = (
      await db
        .select({ contract: contracts })
        .from(contracts)
        .innerJoin(contractApps, eq(contractApps.contractId, contracts.id))
        .where(and(eq(contractApps.appId, input.appId), eq(contracts.companyId, input.companyId)))
    )
      .map((row) => row.contract)
      .filter((row) => covers(row, input.occurredOn))
  } else {
    candidates = (await db.select().from(contracts).where(eq(contracts.companyId, input.companyId))).filter((row) => covers(row, input.occurredOn))
  }
  if (candidates.length === 0) return { contractId: null, cycleId: null }
  if (candidates.length > 1) throw new HTTPException(422, { message: 'contract_id is required: more than one contract covers that day' })
  const contract = candidates[0]!
  await syncCycles(db, contract, input.day)
  const [cycle] = await db
    .select()
    .from(contractCycles)
    .where(and(eq(contractCycles.contractId, contract.id), sql`${contractCycles.startsOn} <= ${input.occurredOn}`, gt(contractCycles.endsOn, input.occurredOn)))
    .limit(1)
  if (cycle && cycle.status !== 'open') {
    throw new HTTPException(409, { message: `${input.occurredOn} belongs to a cycle that is already closed; its balance is final` })
  }
  return { contractId: contract.id, cycleId: cycle?.id ?? null }
}

/** What a lapsed contract still lets the covered app do in grace, for the routes that pause in grace. */
const graceAllows = async (db: Database, appId: string, allowance: GraceAllowance) => {
  const [row] = await db
    .select({ graceAllows: contracts.graceAllows })
    .from(contracts)
    .innerJoin(contractApps, eq(contractApps.contractId, contracts.id))
    .where(and(eq(contractApps.appId, appId), isNotNull(contracts.lapsedAt), isNull(contracts.cancelledAt)))
    .orderBy(desc(contracts.endsOn))
    .limit(1)
  return row ? parseJsonArray<string>(row.graceAllows).includes(allowance) : false
}

/** Who at the client is told about the contract: billing and owners, else the primary contact, else anyone. */
const noticeRecipients = async (db: Database, companyId: string) => {
  const rows = await db
    .select({ emails: contacts.emails, roles: companyContacts.roles, isPrimary: companyContacts.isPrimary })
    .from(companyContacts)
    .innerJoin(contacts, eq(contacts.id, companyContacts.contactId))
    .where(eq(companyContacts.companyId, companyId))
  const first = (value: string) => parseJsonArray<string>(value).find((email) => email.includes('@')) ?? null
  const pick = (filter: (row: (typeof rows)[number]) => boolean) => rows.filter(filter).map((row) => first(row.emails)).filter((email): email is string => email !== null)
  let recipients = pick((row) => parseJsonArray<string>(row.roles).some((role) => role === 'billing' || role === 'owner'))
  if (recipients.length === 0) recipients = pick((row) => row.isPrimary)
  if (recipients.length === 0) recipients = pick(() => true)
  return [...new Set(recipients.map((email) => email.toLowerCase()))]
}

/**
 * The in-app notice the covered apps show before a contract ends. The client's end users read
 * Spanish, so it is written in Spanish; English is kept beside it for the day a client is not
 * Chilean, the same way the email templates carry both.
 */
const NOTICE_COPY = {
  en: {
    title: 'The service contract is ending',
    body: (endsOn: string, graceDays: number) =>
      graceDays > 0
        ? `The maintenance contract for this app ends on ${endsOn}. If it is not renewed, the app keeps working for ${graceDays} more days and is then suspended.`
        : `The maintenance contract for this app ends on ${endsOn}. If it is not renewed, the app is suspended on that date.`,
  },
  es: {
    title: 'El contrato de servicio está por terminar',
    body: (endsOn: string, graceDays: number) =>
      graceDays > 0
        ? `El contrato de mantención de esta app termina el ${endsOn}. Si no se renueva, la app sigue funcionando ${graceDays} días más y luego se suspende.`
        : `El contrato de mantención de esta app termina el ${endsOn}. Si no se renueva, la app se suspende en esa fecha.`,
  },
} as const

const NOTICE_LOCALE = 'es' as const

/** `created_by` on the in-app notices a contract posts, so renewing it can end them. */
const noticeAuthor = (contractId: string) => `contract:${contractId}`

/** Emails the client and posts the in-app notice. Throws only if the email fails, so the next run retries. */
const sendNotice = async (env: Env, db: Database, contract: ContractRow, now: Date) => {
  const [company] = await db.select().from(companies).where(eq(companies.id, contract.companyId)).limit(1)
  const covered = (await coveredApps(db, [contract.id])).get(contract.id) ?? []
  const recipients = await noticeRecipients(db, contract.companyId)
  const endsOn = contract.endsOn!
  if (recipients.length > 0) {
    const rendered = await renderContractNoticeEmail({
      companyName: company?.tradeName || company?.legalName || '',
      contractName: contract.name,
      endsOn: formatMailDay(endsOn, NOTICE_LOCALE),
      apps: covered.map((app) => app.name),
      graceDays: contract.graceDays,
      locale: NOTICE_LOCALE,
      brandName: env.MAIL_FROM_NAME,
    })
    await sendMail(env, { to: recipients, ...rendered })
  }
  const copy = NOTICE_COPY[NOTICE_LOCALE]
  const endsAt = startOfZonedDay(addDays(endsOn, 1))
  const statements = covered.map((app) =>
    db.insert(messages).values({
      id: crypto.randomUUID(),
      appId: app.id,
      title: copy.title,
      body: copy.body(formatMailDay(endsOn, NOTICE_LOCALE), contract.graceDays),
      severity: 'warning',
      display: 'banner',
      scope: 'app',
      scopeValue: '',
      startsAt: now,
      endsAt,
      createdBy: noticeAuthor(contract.id),
    }),
  )
  await db.batch([
    db.update(contracts).set({ noticeSentAt: now }).where(eq(contracts.id, contract.id)),
    db.insert(auditLogs).values(
      auditRow({ event: 'contract.notice_sent', resourceType: 'contract', resourceId: contract.id, metadata: { automatic: true, recipients, apps: covered.map((app) => app.id), ends_on: endsOn } }),
    ),
    ...statements,
  ])
  for (const app of covered) await syncApp(env, app.id)
}

/** Puts the covered apps in grace — or suspends them, with no grace days — when a contract lapses. */
const lapse = async (env: Env, db: Database, contract: ContractRow, now: Date) => {
  const covered = (await coveredApps(db, [contract.id])).get(contract.id) ?? []
  const endsOn = contract.endsOn!
  const state = contract.graceDays > 0 ? 'grace' : 'suspended'
  const until = contract.graceDays > 0 ? startOfZonedDay(addDays(endsOn, contract.graceDays + 1)) : null
  const touched: string[] = []
  for (const app of covered) {
    if (app.state === 'suspended') continue
    const [before] = await db.select().from(apps).where(eq(apps.id, app.id)).limit(1)
    if (!before) continue
    const [updated] = await db
      .update(apps)
      .set({ state, stateUntil: until, stateMessage: contract.graceMessage ?? before.stateMessage, updatedAt: now })
      .where(and(eq(apps.id, app.id), ne(apps.state, 'suspended')))
      .returning()
    if (!updated) continue
    touched.push(app.id)
    await db.insert(auditLogs).values(
      auditRow({
        event: 'app.state_changed',
        resourceType: 'app',
        resourceId: app.id,
        metadata: {
          automatic: true,
          reason: 'contract_lapsed',
          contract_id: contract.id,
          before: { state: before.state, message: before.stateMessage, until: iso(before.stateUntil) },
          after: { state: updated.state, message: updated.stateMessage, until: iso(updated.stateUntil) },
        },
      }),
    )
  }
  await db.batch([
    db.update(contracts).set({ lapsedAt: now }).where(eq(contracts.id, contract.id)),
    db.insert(auditLogs).values(auditRow({ event: 'contract.lapsed', resourceType: 'contract', resourceId: contract.id, metadata: { automatic: true, ends_on: endsOn, state, apps: touched } })),
  ])
  for (const id of touched) await syncApp(env, id)
  return touched.length
}

/**
 * What renewing a contract undoes: the apps a lapse put in grace or suspended are reactivated, the
 * notices it posted end, and it can be warned about again before its new end. Called after
 * `ends_on` moved — by hand, or by the cron for a contract that renews itself.
 */
const afterRenewal = async (env: Env, db: Database, contract: ContractRow, actor: { actorEmail: string | null; actorId?: string | null }, now: Date) => {
  const day = todayIn(now)
  const stillEnded = contract.endsOn !== null && contract.endsOn < day
  const reactivated: string[] = []
  if (contract.lapsedAt && !stillEnded) {
    const covered = (await coveredApps(db, [contract.id])).get(contract.id) ?? []
    for (const app of covered) {
      if (app.state !== 'grace' && app.state !== 'suspended') continue
      const [before] = await db.select().from(apps).where(eq(apps.id, app.id)).limit(1)
      const [updated] = await db
        .update(apps)
        .set({ state: 'active', stateUntil: null, stateMessage: null, updatedAt: now })
        .where(and(eq(apps.id, app.id), inArray(apps.state, ['grace', 'suspended'])))
        .returning()
      if (!updated || !before) continue
      reactivated.push(app.id)
      await db.insert(auditLogs).values(
        auditRow({
          event: 'app.state_changed',
          resourceType: 'app',
          resourceId: app.id,
          ...actor,
          metadata: {
            automatic: actor.actorEmail === null,
            reason: 'contract_renewed',
            contract_id: contract.id,
            before: { state: before.state, message: before.stateMessage, until: iso(before.stateUntil) },
            after: { state: 'active', message: null, until: null },
          },
        }),
      )
    }
  }
  const outsideNotice = !contract.endsOn || day < addDays(contract.endsOn, -contract.noticeDays)
  await db.batch([
    db
      .update(contracts)
      .set({
        ...(contract.lapsedAt && !stillEnded ? { lapsedAt: null } : {}),
        ...(outsideNotice ? { noticeSentAt: null } : {}),
        updatedAt: now,
      })
      .where(eq(contracts.id, contract.id)),
    db
      .update(messages)
      .set({ endsAt: now, updatedAt: now })
      .where(and(eq(messages.createdBy, noticeAuthor(contract.id)), sql`(${messages.endsAt} IS NULL OR ${messages.endsAt} > ${Math.floor(now.getTime() / 1000)})`)),
  ])
  for (const id of reactivated) await syncApp(env, id)
  return reactivated
}

/** The cron's share of contracts: renew, warn, lapse, and keep every cycle current. */
const runContracts = async (env: Env, now: Date) => {
  const db = getDb(env)
  const day = todayIn(now)
  const totals = { renewed: 0, notices: 0, lapsed: 0, failed: 0 }
  const rows = await db.select().from(contracts).where(isNull(contracts.cancelledAt))
  for (let row of rows) {
    try {
      if (row.autoRenew && row.endsOn && row.endsOn < day) {
        let endsOn = row.endsOn
        for (let step = 0; step < 100 && endsOn < day; step += 1) endsOn = addDays(addMonths(addDays(endsOn, 1), row.renewalMonths), -1)
        const [renewed] = await db.update(contracts).set({ endsOn, updatedAt: now }).where(eq(contracts.id, row.id)).returning()
        await db.insert(auditLogs).values(auditRow({ event: 'contract.renewed', resourceType: 'contract', resourceId: row.id, metadata: { automatic: true, before: { ends_on: row.endsOn }, after: { ends_on: endsOn } } }))
        row = renewed!
        await afterRenewal(env, db, row, { actorEmail: null }, now)
        totals.renewed += 1
      }
      if (!row.autoRenew && row.endsOn && !row.noticeSentAt && day >= addDays(row.endsOn, -row.noticeDays) && day <= row.endsOn) {
        await sendNotice(env, db, row, now)
        totals.notices += 1
      }
      if (!row.autoRenew && row.endsOn && row.endsOn < day && !row.lapsedAt) {
        await lapse(env, db, row, now)
        totals.lapsed += 1
      }
      await syncCycles(db, row, day, null, now)
    } catch (error) {
      totals.failed += 1
      console.error('contract maintenance failed', row.id, error)
    }
  }
  return totals
}

export {
  afterRenewal,
  CONTRACT_STATUSES,
  contractStatus,
  coveredApps,
  covers,
  graceAllows,
  noticeRecipients,
  resolveWorkLogTarget,
  runContracts,
  syncCycles,
  todayIn,
  toContract,
  toCycle,
  toWorkLog,
  usageOf,
}
export type { ContractRow, ContractStatus, CycleRow, WorkLogRow }
