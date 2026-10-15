import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createApp, createCompany, panelJson } from '../helpers/api'

const auditFor = async (resourceId: string) =>
  (await env.DB.prepare('SELECT event, actor_email, metadata FROM audit_logs WHERE resource_id = ? ORDER BY created_at, rowid').bind(resourceId).all<{ event: string; actor_email: string; metadata: string }>()).results

describe('companies', () => {
  it('are created with their RUT normalised and their author recorded', async () => {
    const company = await createCompany({ rut: '76.086.428-5', trade_name: 'Andes', business_activity: 'Retail', is_company: true })
    expect(company).toMatchObject({ legal_name: 'Comercial Andes SpA', trade_name: 'Andes', rut: '76086428-5', is_company: true, app_count: 0, created_by: 'fran@franciscosolis.cl' })
    expect((await auditFor(company.id)).map((row) => row.event)).toEqual(['company.created'])
  })

  it('refuse a RUT whose check digit is wrong', async () => {
    const { status, body } = await panelJson('/v1/companies', { method: 'POST', body: { legal_name: 'X', rut: '76.086.428-4' } })
    expect(status).toBe(422)
    expect(body.error).toMatch(/check digit/)
  })

  it('refuse a second company with the same RUT, however it is typed', async () => {
    await createCompany({ rut: '12.345.678-5' })
    const { status } = await panelJson('/v1/companies', { method: 'POST', body: { legal_name: 'Copy', rut: '123456785' } })
    expect(status).toBe(409)
  })

  it('allow any number of companies without a RUT', async () => {
    await createCompany({ rut: null, legal_name: 'Juan Pérez', is_company: false })
    await createCompany({ rut: '', legal_name: 'María Soto', is_company: false })
    const { body } = await panelJson('/v1/companies')
    expect(body.pagination.total).toBe(2)
  })

  it('report a missing field in the service error shape', async () => {
    const { status, body } = await panelJson('/v1/companies', { method: 'POST', body: { rut: '12345678-5' } })
    expect(status).toBe(400)
    expect(body.code).toBe(400)
    expect(body.error).toMatch(/legal_name/)
  })

  it('are searched by name, trade name and RUT', async () => {
    await createCompany({ legal_name: 'Alfa Limitada', rut: '11.111.111-1' })
    await createCompany({ legal_name: 'Beta SpA', trade_name: 'Kiosco 100%', rut: null })
    expect((await panelJson('/v1/companies?search=alfa')).body.data.map((c: any) => c.legal_name)).toEqual(['Alfa Limitada'])
    expect((await panelJson('/v1/companies?search=11.111')).body.data.map((c: any) => c.legal_name)).toEqual(['Alfa Limitada'])
    // A % in the term is a literal, not a wildcard.
    expect((await panelJson('/v1/companies?search=100%25')).body.data.map((c: any) => c.legal_name)).toEqual(['Beta SpA'])
  })

  it('are edited with a diff in the audit trail', async () => {
    const company = await createCompany()
    const { status, body } = await panelJson(`/v1/companies/${company.id}`, { method: 'PATCH', body: { trade_name: 'Andes', notes: null } })
    expect(status).toBe(200)
    expect(body.data.trade_name).toBe('Andes')
    const [, updated] = await auditFor(company.id)
    expect(updated!.event).toBe('company.updated')
    expect(JSON.parse(updated!.metadata)).toEqual({ before: { trade_name: null }, after: { trade_name: 'Andes' } })
  })

  it('cannot be deleted while they have apps', async () => {
    const created = await createApp()
    const { status } = await panelJson(`/v1/companies/${created.company_id}`, { method: 'DELETE' })
    expect(status).toBe(409)
  })

  it('are deleted, contacts unlinked but kept', async () => {
    const company = await createCompany()
    const contact = (await panelJson('/v1/contacts', { method: 'POST', body: { name: 'Ana' } })).body.data
    await panelJson(`/v1/companies/${company.id}/contacts/${contact.id}`, { method: 'PUT', body: { roles: ['owner'] } })
    expect((await panelJson(`/v1/companies/${company.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await panelJson(`/v1/companies/${company.id}`)).status).toBe(404)
    expect((await panelJson(`/v1/contacts/${contact.id}`)).body.data.companies).toEqual([])
  })

  it('answer 404 for an id that is not a UUID', async () => {
    expect((await panelJson('/v1/companies/not-a-uuid')).status).toBe(404)
  })
})

describe('contacts', () => {
  it('keep several addresses and phones, de-duplicated', async () => {
    const { status, body } = await panelJson('/v1/contacts', {
      method: 'POST',
      body: { name: 'Ana Rojas', emails: ['Ana@Andes.cl', 'ana@andes.cl', 'ana.personal@example.test'], phones: ['+56 9 1234 5678', '+56 9 1234 5678'] },
    })
    expect(status).toBe(201)
    expect(body.data.emails).toEqual(['ana@andes.cl', 'ana.personal@example.test'])
    expect(body.data.phones).toEqual(['+56 9 1234 5678'])
  })

  it('refuse a malformed address', async () => {
    expect((await panelJson('/v1/contacts', { method: 'POST', body: { name: 'X', emails: ['not-an-email'] } })).status).toBe(400)
  })

  it('belong to several companies with different roles', async () => {
    const first = await createCompany({ legal_name: 'Primera', rut: '11.111.111-1' })
    const second = await createCompany({ legal_name: 'Segunda', rut: '12.345.678-5' })
    const contact = (await panelJson('/v1/contacts', { method: 'POST', body: { name: 'Ana' } })).body.data

    await panelJson(`/v1/companies/${first.id}/contacts/${contact.id}`, { method: 'PUT', body: { roles: ['owner', 'billing', 'owner'], is_primary: true } })
    await panelJson(`/v1/companies/${second.id}/contacts/${contact.id}`, { method: 'PUT', body: { roles: ['technical'] } })

    const detail = (await panelJson(`/v1/contacts/${contact.id}`)).body.data
    expect(detail.company_count).toBe(2)
    expect(detail.companies.map((link: any) => [link.company.legal_name, link.roles, link.is_primary])).toEqual([
      ['Primera', ['owner', 'billing'], true],
      ['Segunda', ['technical'], false],
    ])
    expect((await panelJson(`/v1/contacts?company_id=${second.id}`)).body.data.map((c: any) => c.name)).toEqual(['Ana'])
  })

  it('leave a company with at most one primary contact', async () => {
    const company = await createCompany()
    const ana = (await panelJson('/v1/contacts', { method: 'POST', body: { name: 'Ana' } })).body.data
    const beto = (await panelJson('/v1/contacts', { method: 'POST', body: { name: 'Beto' } })).body.data
    await panelJson(`/v1/companies/${company.id}/contacts/${ana.id}`, { method: 'PUT', body: { roles: ['owner'], is_primary: true } })
    await panelJson(`/v1/companies/${company.id}/contacts/${beto.id}`, { method: 'PUT', body: { roles: ['maintenance_approver'], is_primary: true } })

    const links = (await panelJson(`/v1/companies/${company.id}/contacts`)).body.data
    expect(links.map((link: any) => [link.contact.name, link.is_primary])).toEqual([
      ['Beto', true],
      ['Ana', false],
    ])
  })

  it('refuse a role outside the vocabulary', async () => {
    const company = await createCompany()
    const contact = (await panelJson('/v1/contacts', { method: 'POST', body: { name: 'Ana' } })).body.data
    expect((await panelJson(`/v1/companies/${company.id}/contacts/${contact.id}`, { method: 'PUT', body: { roles: ['ceo'] } })).status).toBe(400)
  })

  it('are unlinked without being deleted', async () => {
    const company = await createCompany()
    const contact = (await panelJson('/v1/contacts', { method: 'POST', body: { name: 'Ana' } })).body.data
    await panelJson(`/v1/companies/${company.id}/contacts/${contact.id}`, { method: 'PUT', body: { roles: ['owner'] } })
    expect((await panelJson(`/v1/companies/${company.id}/contacts/${contact.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await panelJson(`/v1/companies/${company.id}/contacts/${contact.id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await panelJson(`/v1/contacts/${contact.id}`)).status).toBe(200)
  })

  it('are searched by name, address and phone', async () => {
    await panelJson('/v1/contacts', { method: 'POST', body: { name: 'Ana', emails: ['ana@andes.cl'] } })
    await panelJson('/v1/contacts', { method: 'POST', body: { name: 'Beto', phones: ['+56 2 2222 3333'] } })
    expect((await panelJson('/v1/contacts?search=andes')).body.data.map((c: any) => c.name)).toEqual(['Ana'])
    expect((await panelJson('/v1/contacts?search=2222')).body.data.map((c: any) => c.name)).toEqual(['Beto'])
  })

  it('show up on their company with their roles', async () => {
    const company = await createCompany()
    const contact = (await panelJson('/v1/contacts', { method: 'POST', body: { name: 'Ana' } })).body.data
    await panelJson(`/v1/companies/${company.id}/contacts/${contact.id}`, { method: 'PUT', body: { roles: ['maintenance_approver'] } })
    const detail = (await panelJson(`/v1/companies/${company.id}`)).body.data
    expect(detail.contact_count).toBe(1)
    expect(detail.contacts[0]).toMatchObject({ roles: ['maintenance_approver'], contact: { name: 'Ana' } })
  })

  it('are edited, lists replaced whole, and deleted from every company', async () => {
    const company = await createCompany()
    const contact = (await panelJson('/v1/contacts', { method: 'POST', body: { name: 'Ana', emails: ['ana@andes.cl'] } })).body.data
    await panelJson(`/v1/companies/${company.id}/contacts/${contact.id}`, { method: 'PUT', body: { roles: ['owner'] } })

    const { body } = await panelJson(`/v1/contacts/${contact.id}`, { method: 'PATCH', body: { emails: ['ana.rojas@andes.cl'], address: 'Av. Providencia 123' } })
    expect(body.data).toMatchObject({ emails: ['ana.rojas@andes.cl'], address: 'Av. Providencia 123', name: 'Ana' })
    const [, updated] = await auditFor(contact.id)
    expect(JSON.parse(updated!.metadata)).toEqual({
      before: { emails: ['ana@andes.cl'], address: null },
      after: { emails: ['ana.rojas@andes.cl'], address: 'Av. Providencia 123' },
    })

    expect((await panelJson(`/v1/contacts/${contact.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await panelJson(`/v1/contacts/${contact.id}`)).status).toBe(404)
    expect((await panelJson(`/v1/companies/${company.id}`)).body.data.contacts).toEqual([])
  })
})
