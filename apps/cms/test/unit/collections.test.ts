import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import type { CollectionName } from '@/lib/collections'
import { COLLECTION_NAMES, COLLECTIONS, isCollection, parseCollectionData } from '@/lib/collections'

/** Shorthand for "this blob is not valid for that collection". */
const rejects = (collection: CollectionName, data: unknown) =>
  expect(() => parseCollectionData(collection, data)).toThrow(v.ValiError)

describe('the registry', () => {
  it('exposes every collection the landing page needs', () => {
    expect([...COLLECTION_NAMES]).toEqual(['projects', 'experience', 'skills', 'certifications', 'education'])
  })

  it('labels every collection with something a CMS front-end can put on a tab', () => {
    // `GET /collections` hands these straight to a UI, so an empty or copy-pasted label is a real
    // defect even though the type system is happy with one.
    const names = COLLECTION_NAMES.map((slug) => COLLECTIONS[slug].name)
    const descriptions = COLLECTION_NAMES.map((slug) => COLLECTIONS[slug].description)

    for (const slug of COLLECTION_NAMES) {
      const { name, description } = COLLECTIONS[slug]
      expect(name.trim(), slug).not.toBe('')
      expect(description.trim(), slug).not.toBe('')
      expect(name, slug).not.toBe(slug)
      expect(description, slug).not.toBe(name)
    }

    expect(new Set(names).size).toBe(names.length)
    expect(new Set(descriptions).size).toBe(descriptions.length)
  })

  it('wires each name to its own schema rather than sharing one', () => {
    // A copy-paste that pointed two collections at the same schema would let a certification field
    // through on a project. The distinct-field probe below is what catches it.
    const probes: Record<CollectionName, Record<string, unknown>> = {
      projects: { client: 'ACME' },
      experience: { company: 'ACME' },
      skills: { level: 3 },
      certifications: { issuer: 'Cloudflare' },
      education: { institution: 'UTEM' },
    }

    for (const owner of COLLECTION_NAMES) {
      expect(parseCollectionData(owner, probes[owner]), owner).toEqual(probes[owner])
      for (const other of COLLECTION_NAMES.filter((slug) => slug !== owner)) {
        rejects(other, probes[owner])
      }
    }
  })
})

describe('isCollection', () => {
  it('accepts every registered slug', () => {
    for (const slug of COLLECTION_NAMES) {
      expect(isCollection(slug)).toBe(true)
    }
  })

  it('rejects an unregistered one', () => {
    expect(isCollection('talks')).toBe(false)
    expect(isCollection('')).toBe(false)
    expect(isCollection('Projects')).toBe(false)
  })

  it('lets an inherited Object property through, because the check is `in`', () => {
    // Known gap, reported separately: `value in COLLECTIONS` walks the prototype chain, so these
    // names pass the guard even though no such collection exists. Pinned here so a fix has to
    // come past this test rather than land silently.
    expect(isCollection('toString')).toBe(true)
    expect(isCollection('constructor')).toBe(true)
  })

  it('has no schema behind such a name, so a write against it fails loudly', () => {
    // What bounds the gap above. `COLLECTIONS.toString` resolves to `Function.prototype.toString`,
    // which has no `schema`, so valibot is handed `undefined` and throws a TypeError — not a
    // ValiError, and not a silent pass. `routes/admin/content.ts` turns that into a 422.
    let thrown: unknown
    try {
      parseCollectionData('toString' as CollectionName, { anything: true })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(TypeError)
    expect(thrown).not.toBeInstanceOf(v.ValiError)
    expect((thrown as TypeError).message).toContain('undefined')
  })

  it('carries no collection definition for a prototype name, whatever the guard says', () => {
    // The guard is the only thing that says yes; nothing behind it does.
    expect(Object.hasOwn(COLLECTIONS, 'toString')).toBe(false)
    expect(Object.hasOwn(COLLECTIONS, 'constructor')).toBe(false)
    expect(COLLECTION_NAMES).not.toContain('toString' as CollectionName)
  })
})

describe('parseCollectionData', () => {
  it('defaults `undefined` to an empty object', () => {
    expect(parseCollectionData('projects', undefined)).toEqual({})
  })

  it('defaults `null` to an empty object too', () => {
    expect(parseCollectionData('projects', null)).toEqual({})
  })

  it('rejects a non-object blob', () => {
    rejects('projects', 'not an object')
    rejects('projects', 42)
    rejects('projects', ['a'])
  })

  it('returns a parsed copy rather than the input', () => {
    const input = { role: 'Backend' }
    const parsed = parseCollectionData('projects', input)
    expect(parsed).toEqual({ role: 'Backend' })
    expect(parsed).not.toBe(input)
  })

  it('trims text fields', () => {
    expect(parseCollectionData('projects', { role: '  Backend  ' })).toEqual({ role: 'Backend' })
  })
})

describe('projects data', () => {
  it('accepts a full valid blob', () => {
    const data = {
      role: 'Tech lead',
      client: 'ACME',
      technologies: ['TypeScript', 'Cloudflare Workers'],
      repository_url: 'https://github.com/franciscosolis/example',
      demo_url: 'https://example.com',
      highlights: ['Cut latency in half'],
    }
    expect(parseCollectionData('projects', data)).toEqual(data)
  })

  it('rejects an unknown field instead of silently storing it', () => {
    rejects('projects', { rolle: 'typo' })
    rejects('projects', { role: 'ok', extra: true })
  })

  it('rejects a non-URL in a URL field', () => {
    rejects('projects', { repository_url: 'github.com/no-scheme' })
    rejects('projects', { demo_url: 'not a url' })
    rejects('projects', { repository_url: '' })
  })

  it('rejects an empty string inside a string list', () => {
    rejects('projects', { technologies: ['  '] })
  })

  it('rejects a too-long list item', () => {
    rejects('projects', { technologies: ['x'.repeat(61)] })
    expect(parseCollectionData('projects', { technologies: ['x'.repeat(60)] })).toEqual({
      technologies: ['x'.repeat(60)],
    })
  })

  it('rejects a role past its 120 character bound', () => {
    rejects('projects', { role: 'x'.repeat(121) })
  })

  it('accepts an empty list', () => {
    expect(parseCollectionData('projects', { technologies: [] })).toEqual({ technologies: [] })
  })
})

describe('experience data', () => {
  it('accepts a full valid blob', () => {
    const data = {
      company: 'ACME',
      position: 'Senior engineer',
      location: 'Santiago',
      employment_type: 'full-time',
      company_url: 'https://acme.example',
      achievements: ['Shipped the thing'],
      technologies: ['Go'],
    }
    expect(parseCollectionData('experience', data)).toEqual(data)
  })

  it('rejects an unknown field', () => {
    rejects('experience', { salary: 100 })
  })

  it('rejects a non-URL company link', () => {
    rejects('experience', { company_url: 'acme.example' })
  })

  it('does not accept a project-only field', () => {
    rejects('experience', { client: 'ACME' })
  })
})

describe('skills data', () => {
  it('accepts a full valid blob', () => {
    const data = { category: 'backend', level: 4, years_of_experience: 7.5, icon: 'typescript' }
    expect(parseCollectionData('skills', data)).toEqual(data)
  })

  it('holds level to 1..5 inclusive', () => {
    expect(parseCollectionData('skills', { level: 1 })).toEqual({ level: 1 })
    expect(parseCollectionData('skills', { level: 5 })).toEqual({ level: 5 })
    rejects('skills', { level: 0 })
    rejects('skills', { level: 6 })
    rejects('skills', { level: -1 })
  })

  it('requires level to be a whole number', () => {
    rejects('skills', { level: 3.5 })
  })

  it('holds years_of_experience to 0..80 inclusive', () => {
    expect(parseCollectionData('skills', { years_of_experience: 0 })).toEqual({ years_of_experience: 0 })
    expect(parseCollectionData('skills', { years_of_experience: 80 })).toEqual({ years_of_experience: 80 })
    rejects('skills', { years_of_experience: -0.5 })
    rejects('skills', { years_of_experience: 81 })
  })

  it('allows a fractional years_of_experience, unlike level', () => {
    expect(parseCollectionData('skills', { years_of_experience: 2.5 })).toEqual({ years_of_experience: 2.5 })
  })

  it('rejects a numeric field sent as a string', () => {
    rejects('skills', { level: '4' })
    rejects('skills', { years_of_experience: '7' })
  })

  it('rejects an unknown field', () => {
    rejects('skills', { proficiency: 4 })
  })
})

describe('certifications data', () => {
  it('accepts a full valid blob', () => {
    const data = {
      issuer: 'Cloudflare',
      credential_id: 'ABC-123',
      credential_url: 'https://verify.example/ABC-123',
      expires: true,
    }
    expect(parseCollectionData('certifications', data)).toEqual(data)
  })

  it('rejects a non-URL verification link', () => {
    rejects('certifications', { credential_url: 'verify.example/ABC-123' })
  })

  it('rejects a non-boolean `expires`', () => {
    rejects('certifications', { expires: 'yes' })
    rejects('certifications', { expires: 1 })
  })

  it('rejects an unknown field', () => {
    rejects('certifications', { expiry_date: '2027-01-01' })
  })
})

describe('education data', () => {
  it('accepts a full valid blob', () => {
    const data = {
      institution: 'Universidad Tecnológica Metropolitana',
      degree: 'Ingeniería Civil en Computación',
      field: 'Computer science',
      location: 'Santiago',
      institution_url: 'https://utem.cl',
    }
    expect(parseCollectionData('education', data)).toEqual(data)
  })

  it('rejects an unknown field', () => {
    rejects('education', { gpa: 6.5 })
  })

  it('rejects a non-URL institution link', () => {
    rejects('education', { institution_url: 'utem.cl' })
  })

  it('rejects an institution past its 160 character bound', () => {
    rejects('education', { institution: 'x'.repeat(161) })
    expect(parseCollectionData('education', { institution: 'x'.repeat(160) })).toEqual({
      institution: 'x'.repeat(160),
    })
  })
})

describe('every collection', () => {
  it('rejects an unknown field, which is what `strictObject` buys', () => {
    for (const slug of COLLECTION_NAMES) {
      rejects(slug, { definitely_not_a_field: 'x' })
    }
  })

  it('accepts an empty blob', () => {
    for (const slug of COLLECTION_NAMES) {
      expect(parseCollectionData(slug, {})).toEqual({})
    }
  })

  it('rejects a URL longer than 2048 characters', () => {
    const urlField: Record<CollectionName, string | null> = {
      projects: 'repository_url',
      experience: 'company_url',
      skills: null,
      certifications: 'credential_url',
      education: 'institution_url',
    }

    for (const slug of COLLECTION_NAMES) {
      const field = urlField[slug]
      if (!field) {
        continue
      }
      rejects(slug, { [field]: `https://example.com/${'x'.repeat(2048)}` })
    }
  })
})
