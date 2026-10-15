import { asc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import * as v from 'valibot'
import { getDb, type Database } from '@/db/client'
import { companies, companyContacts, contacts } from '@/db/schema'
import type { AppEnv } from '@/env'
import { optionalText, paginationQuery, requiredText, searchQuery } from '@/lib/validation'
import { validate } from '@/lib/validate'
import { diff, getActorContext, recordAudit } from '@/services/audit'
import { toCompanyBrief, toContact, toLink } from '@/services/serialize'
import { assertId, dataSchema, jsonContent, likeTerm, listSchema, notFound, page, panelErrors } from '@/panel/shared'

/**
 * Contacts: people, each of whom may belong to several companies. The roles live on the link, so
 * they are edited from the company side (`PUT /companies/:id/contacts/:contactId`).
 */
const app = new Hono<AppEnv>()

const contactSchema = v.looseObject({ id: v.string(), name: v.string(), emails: v.array(v.string()) })

/** Addresses, lowercased and de-duplicated: the same inbox typed twice is one address. */
const emailsInput = v.pipe(
  v.array(v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email(), v.maxLength(320))),
  v.maxLength(10),
  v.transform((emails) => [...new Set(emails)]),
)

/** Phone numbers as typed — formats vary too much by country to normalise — de-duplicated. */
const phonesInput = v.pipe(
  v.array(v.pipe(v.string(), v.trim(), v.minLength(3), v.maxLength(40), v.regex(/^[+\d\s().-]+$/, 'must be a phone number'))),
  v.maxLength(10),
  v.transform((phones) => [...new Set(phones)]),
)

const createSchema = v.object({
  name: requiredText(200),
  emails: v.optional(emailsInput),
  phones: v.optional(phonesInput),
  address: optionalText(400),
  notes: optionalText(5000),
})

const patchSchema = v.object({
  name: v.optional(requiredText(200)),
  emails: v.optional(emailsInput),
  phones: v.optional(phonesInput),
  address: optionalText(400),
  notes: optionalText(5000),
})

const companiesCount = sql<number>`(SELECT COUNT(*) FROM company_contacts WHERE company_contacts.contact_id = "contacts"."id")`

const loadContact = async (db: Database, id: string) => {
  const [row] = await db.select({ contact: contacts, companies: companiesCount }).from(contacts).where(eq(contacts.id, id)).limit(1)
  if (!row) throw notFound('Contact')
  return toContact(row.contact, { companies: Number(row.companies) })
}

app.get(
  '/contacts',
  describeRoute({
    description: 'Every contact, alphabetically. `search` matches the name, an email or a phone; `company_id` narrows to one company.',
    tags: ['Contacts'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The contacts', content: jsonContent(listSchema(contactSchema)) }, ...panelErrors },
  }),
  validate('query', v.object({ search: searchQuery, company_id: v.optional(v.pipe(v.string(), v.uuid())), ...paginationQuery })),
  async (c) => {
    const query = c.req.valid('query')
    const { limit, offset } = page(query)
    const db = getDb(c.env)
    const conditions = []
    if (query.search) {
      const term = likeTerm(query.search)
      conditions.push(sql`(${contacts.name} LIKE ${term} ESCAPE '\\' OR ${contacts.emails} LIKE ${term} ESCAPE '\\' OR ${contacts.phones} LIKE ${term} ESCAPE '\\')`)
    }
    if (query.company_id) {
      conditions.push(sql`${contacts.id} IN (SELECT contact_id FROM company_contacts WHERE company_id = ${query.company_id})`)
    }
    const where = conditions.length ? sql.join(conditions, sql` AND `) : undefined
    const [rows, [total]] = await Promise.all([
      db.select({ contact: contacts, companies: companiesCount }).from(contacts).where(where).orderBy(asc(contacts.name)).limit(limit).offset(offset),
      db.select({ count: sql<number>`COUNT(*)` }).from(contacts).where(where),
    ])
    return c.json({
      code: 200 as const,
      data: rows.map((row) => toContact(row.contact, { companies: Number(row.companies) })),
      pagination: { limit, offset, total: Number(total?.count ?? 0) },
    })
  },
)

app.post(
  '/contacts',
  describeRoute({
    description: 'Creates a contact. Link it to a company, with its roles there, through `PUT /companies/:companyId/contacts/:contactId`.',
    tags: ['Contacts'],
    security: [{ bearerAuth: [] }],
    responses: { 201: { description: 'Created', content: jsonContent(dataSchema(contactSchema, 201)) }, ...panelErrors },
  }),
  validate('json', createSchema),
  async (c) => {
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const id = crypto.randomUUID()
    await db.insert(contacts).values({
      id,
      name: body.name,
      emails: JSON.stringify(body.emails ?? []),
      phones: JSON.stringify(body.phones ?? []),
      address: body.address ?? null,
      notes: body.notes ?? null,
      createdBy: actor.actorEmail,
      updatedBy: actor.actorEmail,
    })
    const contact = await loadContact(db, id)
    await recordAudit(db, { event: 'contact.created', resourceType: 'contact', resourceId: id, ...actor, metadata: { after: contact } })
    return c.json({ code: 201 as const, data: contact }, 201)
  },
)

app.get(
  '/contacts/:contactId',
  describeRoute({
    description: 'One contact, with every company they belong to and their roles at each.',
    tags: ['Contacts'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The contact', content: jsonContent(dataSchema(contactSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('contactId'), 'Contact')
    const db = getDb(c.env)
    const contact = await loadContact(db, id)
    const links = await db
      .select({ link: companyContacts, company: companies })
      .from(companyContacts)
      .innerJoin(companies, eq(companies.id, companyContacts.companyId))
      .where(eq(companyContacts.contactId, id))
      .orderBy(asc(companies.legalName))
    return c.json({
      code: 200 as const,
      data: { ...contact, companies: links.map((row) => ({ ...toLink(row.link), company: toCompanyBrief(row.company) })) },
    })
  },
)

app.patch(
  '/contacts/:contactId',
  describeRoute({
    description: 'Edits a contact. `emails` and `phones` replace the whole list.',
    tags: ['Contacts'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Updated', content: jsonContent(dataSchema(contactSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('json', patchSchema),
  async (c) => {
    const id = assertId(c.req.param('contactId'), 'Contact')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadContact(db, id)
    await db
      .update(contacts)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.emails !== undefined && { emails: JSON.stringify(body.emails) }),
        ...(body.phones !== undefined && { phones: JSON.stringify(body.phones) }),
        ...(body.address !== undefined && { address: body.address }),
        ...(body.notes !== undefined && { notes: body.notes }),
        updatedBy: actor.actorEmail,
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, id))
    const after = await loadContact(db, id)
    await recordAudit(db, { event: 'contact.updated', resourceType: 'contact', resourceId: id, ...actor, metadata: diff(before, after) })
    return c.json({ code: 200 as const, data: after })
  },
)

app.delete(
  '/contacts/:contactId',
  describeRoute({
    description: 'Deletes a contact and unlinks them from every company.',
    tags: ['Contacts'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('contactId'), 'Contact')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadContact(db, id)
    await db.delete(contacts).where(eq(contacts.id, id))
    await recordAudit(db, { event: 'contact.deleted', resourceType: 'contact', resourceId: id, ...actor, metadata: { before } })
    return c.json({ code: 200 as const, data: { id, deleted: true } })
  },
)

export default app
