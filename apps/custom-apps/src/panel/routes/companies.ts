import { and, asc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute } from 'hono-openapi'
import * as v from 'valibot'
import { getDb, type Database } from '@/db/client'
import { apps, companies, companyContacts, contacts } from '@/db/schema'
import type { AppEnv } from '@/env'
import { CONTACT_ROLES } from '@/lib/config'
import { asConflict } from '@/lib/errors'
import { normalizeRut } from '@/lib/rut'
import { optionalText, paginationQuery, requiredText, searchQuery } from '@/lib/validation'
import { validate } from '@/lib/validate'
import { diff, getActorContext, recordAudit } from '@/services/audit'
import { toAppSummary, toCompany, toContact, toLink } from '@/services/serialize'
import {
  assertId,
  connectedSql,
  dataSchema,
  jsonContent,
  likeTerm,
  listSchema,
  notFound,
  nowSeconds,
  page,
  panelErrors,
} from '@/panel/shared'

/**
 * Companies — the clients — and which contacts each has, in what role.
 */
const app = new Hono<AppEnv>()

const companySchema = v.looseObject({ id: v.string(), legal_name: v.string(), rut: v.nullable(v.string()) })

/** A RUT as typed — dots, dash, spaces — normalised, or a 422 when the check digit is wrong. */
const rutInput = v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(20))))

const readRut = (value: string | null | undefined): string | null | undefined => {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const rut = normalizeRut(value)
  if (!rut) {
    throw new HTTPException(422, { message: 'The RUT is not valid: its check digit does not match' })
  }
  return rut
}

const createSchema = v.object({
  legal_name: requiredText(200),
  trade_name: optionalText(200),
  rut: rutInput,
  business_activity: optionalText(200),
  address: optionalText(400),
  is_company: v.optional(v.boolean()),
  notes: optionalText(5000),
})

const patchSchema = v.object({
  legal_name: v.optional(requiredText(200)),
  trade_name: optionalText(200),
  rut: rutInput,
  business_activity: optionalText(200),
  address: optionalText(400),
  is_company: v.optional(v.boolean()),
  notes: optionalText(5000),
})

const countsSelect = {
  apps: sql<number>`(SELECT COUNT(*) FROM apps WHERE apps.company_id = "companies"."id")`,
  contacts: sql<number>`(SELECT COUNT(*) FROM company_contacts WHERE company_contacts.company_id = "companies"."id")`,
}

const loadCompany = async (db: Database, id: string) => {
  const [row] = await db.select({ company: companies, ...countsSelect }).from(companies).where(eq(companies.id, id)).limit(1)
  if (!row) throw notFound('Company')
  return toCompany(row.company, { apps: Number(row.apps), contacts: Number(row.contacts) })
}

const RUT_CONFLICT = 'Another company already has this RUT'

app.get(
  '/companies',
  describeRoute({
    description: 'Every company, alphabetically. `search` matches the legal name, the trade name and the RUT.',
    tags: ['Companies'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The companies', content: jsonContent(listSchema(companySchema)) }, ...panelErrors },
  }),
  validate('query', v.object({ search: searchQuery, ...paginationQuery })),
  async (c) => {
    const query = c.req.valid('query')
    const { limit, offset } = page(query)
    const db = getDb(c.env)
    const where = query.search
      ? sql`(${companies.legalName} LIKE ${likeTerm(query.search)} ESCAPE '\\' OR ${companies.tradeName} LIKE ${likeTerm(query.search)} ESCAPE '\\' OR ${companies.rut} LIKE ${likeTerm(query.search.replace(/\./g, ''))} ESCAPE '\\')`
      : undefined
    const [rows, [total]] = await Promise.all([
      db.select({ company: companies, ...countsSelect }).from(companies).where(where).orderBy(asc(companies.legalName)).limit(limit).offset(offset),
      db.select({ count: sql<number>`COUNT(*)` }).from(companies).where(where),
    ])
    return c.json({
      code: 200 as const,
      data: rows.map((row) => toCompany(row.company, { apps: Number(row.apps), contacts: Number(row.contacts) })),
      pagination: { limit, offset, total: Number(total?.count ?? 0) },
    })
  },
)

app.post(
  '/companies',
  describeRoute({
    description: 'Creates a company. The RUT is optional, accepted with or without dots, and refused with a 422 when its check digit does not match.',
    tags: ['Companies'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'Created', content: jsonContent(dataSchema(companySchema, 201)) },
      409: { description: 'Another company has this RUT' },
      422: { description: 'Invalid RUT' },
      ...panelErrors,
    },
  }),
  validate('json', createSchema),
  async (c) => {
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const id = crypto.randomUUID()
    try {
      await db.insert(companies).values({
        id,
        legalName: body.legal_name,
        tradeName: body.trade_name ?? null,
        rut: readRut(body.rut) ?? null,
        businessActivity: body.business_activity ?? null,
        address: body.address ?? null,
        isCompany: body.is_company ?? true,
        notes: body.notes ?? null,
        createdBy: actor.actorEmail,
        updatedBy: actor.actorEmail,
      })
    } catch (error) {
      throw asConflict(error, RUT_CONFLICT)
    }
    const company = await loadCompany(db, id)
    await recordAudit(db, { event: 'company.created', resourceType: 'company', resourceId: id, ...actor, metadata: { after: company } })
    return c.json({ code: 201 as const, data: company }, 201)
  },
)

app.get(
  '/companies/:companyId',
  describeRoute({
    description: 'One company, with its contacts (and their roles here) and its apps.',
    tags: ['Companies'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The company', content: jsonContent(dataSchema(companySchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('companyId'), 'Company')
    const db = getDb(c.env)
    const company = await loadCompany(db, id)
    const now = nowSeconds()
    const [links, appRows] = await Promise.all([
      db
        .select({ link: companyContacts, contact: contacts, companies: sql<number>`(SELECT COUNT(*) FROM company_contacts cc WHERE cc.contact_id = "contacts"."id")` })
        .from(companyContacts)
        .innerJoin(contacts, eq(contacts.id, companyContacts.contactId))
        .where(eq(companyContacts.companyId, id))
        .orderBy(sql`${companyContacts.isPrimary} DESC`, asc(contacts.name)),
      db
        .select({
          app: apps,
          installations: sql<number>`(SELECT COUNT(*) FROM installations i WHERE i.app_id = "apps"."id")`,
          connected: sql<number>`(SELECT COUNT(*) FROM installations i JOIN apps a ON a.id = i.app_id WHERE i.app_id = "apps"."id" AND ${sql.raw(connectedSql(now))})`,
        })
        .from(apps)
        .where(eq(apps.companyId, id))
        .orderBy(asc(apps.name)),
    ])
    return c.json({
      code: 200 as const,
      data: {
        ...company,
        contacts: links.map((row) => ({ ...toLink(row.link), contact: toContact(row.contact, { companies: Number(row.companies) }) })),
        apps: appRows.map((row) => toAppSummary(row.app, { installations: Number(row.installations), connected: Number(row.connected) })),
      },
    })
  },
)

app.patch(
  '/companies/:companyId',
  describeRoute({
    description: 'Edits a company. A field left out is unchanged; `null` clears it.',
    tags: ['Companies'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Updated', content: jsonContent(dataSchema(companySchema)) },
      404: { description: 'Not found' },
      409: { description: 'Another company has this RUT' },
      422: { description: 'Invalid RUT' },
      ...panelErrors,
    },
  }),
  validate('json', patchSchema),
  async (c) => {
    const id = assertId(c.req.param('companyId'), 'Company')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadCompany(db, id)

    const rut = readRut(body.rut)
    const set: Partial<typeof companies.$inferInsert> = {
      ...(body.legal_name !== undefined && { legalName: body.legal_name }),
      ...(body.trade_name !== undefined && { tradeName: body.trade_name }),
      ...(rut !== undefined && { rut }),
      ...(body.business_activity !== undefined && { businessActivity: body.business_activity }),
      ...(body.address !== undefined && { address: body.address }),
      ...(body.is_company !== undefined && { isCompany: body.is_company }),
      ...(body.notes !== undefined && { notes: body.notes }),
    }
    try {
      await db.update(companies).set({ ...set, updatedBy: actor.actorEmail, updatedAt: new Date() }).where(eq(companies.id, id))
    } catch (error) {
      throw asConflict(error, RUT_CONFLICT)
    }
    const after = await loadCompany(db, id)
    await recordAudit(db, { event: 'company.updated', resourceType: 'company', resourceId: id, ...actor, metadata: diff(before, after) })
    return c.json({ code: 200 as const, data: after })
  },
)

app.delete(
  '/companies/:companyId',
  describeRoute({
    description: 'Deletes a company and its contact links (the contacts themselves stay). Refused with a 409 while the company still has apps — removing a client must never take its fleet with it — or has contracts or logged work, which are billing history.',
    tags: ['Companies'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' }, 409: { description: 'The company still has apps' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('companyId'), 'Company')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadCompany(db, id)
    if (before.app_count > 0) {
      throw new HTTPException(409, { message: `This company still has ${before.app_count} app(s); move or delete them first` })
    }
    // Contracts and logged work are billing history, and the foreign keys refuse to lose them.
    const history = await c.env.DB.prepare('SELECT (SELECT COUNT(*) FROM contracts WHERE company_id = ?) + (SELECT COUNT(*) FROM work_logs WHERE company_id = ?) AS n')
      .bind(id, id)
      .first<{ n: number }>()
    if (Number(history?.n ?? 0) > 0) {
      throw new HTTPException(409, { message: 'This company has contracts or logged work; that history cannot be deleted' })
    }
    await db.delete(companies).where(eq(companies.id, id))
    await recordAudit(db, { event: 'company.deleted', resourceType: 'company', resourceId: id, ...actor, metadata: { before } })
    return c.json({ code: 200 as const, data: { id, deleted: true } })
  },
)

/* ── Contacts of a company ─────────────────────────────────────────────────── */

const linkSchema = v.object({
  roles: v.pipe(v.array(v.picklist(CONTACT_ROLES)), v.maxLength(CONTACT_ROLES.length), v.transform((roles) => [...new Set(roles)])),
  is_primary: v.optional(v.boolean()),
})

app.get(
  '/companies/:companyId/contacts',
  describeRoute({
    description: "A company's contacts with their roles there, the primary one first.",
    tags: ['Companies'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The contacts' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('companyId'), 'Company')
    const db = getDb(c.env)
    await loadCompany(db, id)
    const rows = await db
      .select({ link: companyContacts, contact: contacts, companies: sql<number>`(SELECT COUNT(*) FROM company_contacts cc WHERE cc.contact_id = "contacts"."id")` })
      .from(companyContacts)
      .innerJoin(contacts, eq(contacts.id, companyContacts.contactId))
      .where(eq(companyContacts.companyId, id))
      .orderBy(sql`${companyContacts.isPrimary} DESC`, asc(contacts.name))
    return c.json({
      code: 200 as const,
      data: rows.map((row) => ({ ...toLink(row.link), contact: toContact(row.contact, { companies: Number(row.companies) }) })),
    })
  },
)

app.put(
  '/companies/:companyId/contacts/:contactId',
  describeRoute({
    description:
      'Links a contact to a company with the given roles, or replaces the roles of an existing link. Making a contact primary clears the flag on every other contact of the same company, so a company has at most one — which is who a maintenance request falls back to when nobody holds `maintenance_approver`.',
    tags: ['Companies'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The link' }, 404: { description: 'Company or contact not found' }, ...panelErrors },
  }),
  validate('json', linkSchema),
  async (c) => {
    const companyId = assertId(c.req.param('companyId'), 'Company')
    const contactId = assertId(c.req.param('contactId'), 'Contact')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)

    const [[company], [contact], [existing]] = await Promise.all([
      db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).limit(1),
      db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId)).limit(1),
      db.select().from(companyContacts).where(and(eq(companyContacts.companyId, companyId), eq(companyContacts.contactId, contactId))).limit(1),
    ])
    if (!company) throw notFound('Company')
    if (!contact) throw notFound('Contact')

    const isPrimary = body.is_primary ?? existing?.isPrimary ?? false
    const roles = JSON.stringify(body.roles)
    const statements = [
      ...(isPrimary
        ? [db.update(companyContacts).set({ isPrimary: false }).where(eq(companyContacts.companyId, companyId))]
        : []),
      db
        .insert(companyContacts)
        .values({ companyId, contactId, roles, isPrimary })
        .onConflictDoUpdate({ target: [companyContacts.companyId, companyContacts.contactId], set: { roles, isPrimary } }),
    ]
    await db.batch(statements as [(typeof statements)[number], ...typeof statements])

    const [link] = await db.select().from(companyContacts).where(and(eq(companyContacts.companyId, companyId), eq(companyContacts.contactId, contactId))).limit(1)
    await recordAudit(db, {
      event: 'company_contact.linked',
      resourceType: 'company',
      resourceId: companyId,
      ...actor,
      metadata: { contact_id: contactId, before: existing ? toLink(existing) : null, after: toLink(link!) },
    })
    return c.json({ code: 200 as const, data: toLink(link!) })
  },
)

app.delete(
  '/companies/:companyId/contacts/:contactId',
  describeRoute({
    description: 'Unlinks a contact from a company. The contact itself is kept.',
    tags: ['Companies'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Unlinked' }, 404: { description: 'No such link' }, ...panelErrors },
  }),
  async (c) => {
    const companyId = assertId(c.req.param('companyId'), 'Company')
    const contactId = assertId(c.req.param('contactId'), 'Contact')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const [deleted] = await db
      .delete(companyContacts)
      .where(and(eq(companyContacts.companyId, companyId), eq(companyContacts.contactId, contactId)))
      .returning()
    if (!deleted) throw notFound('Link')
    await recordAudit(db, {
      event: 'company_contact.unlinked',
      resourceType: 'company',
      resourceId: companyId,
      ...actor,
      metadata: { contact_id: contactId, before: toLink(deleted) },
    })
    return c.json({ code: 200 as const, data: { company_id: companyId, contact_id: contactId, deleted: true } })
  },
)

export default app
