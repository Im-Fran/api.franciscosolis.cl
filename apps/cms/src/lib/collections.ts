import * as v from 'valibot'

/**
 * The content model of the landing page.
 *
 * Every collection shares the columns of `content_entries` (title, slug, summary, body, status,
 * position, dates, url, image, tags). What differs between a project and a certification is a
 * handful of extra fields, and those live in the entry's `data` JSON blob, validated here.
 *
 * Adding a collection is a new entry in `COLLECTIONS` — no migration, no new route. The schemas
 * are strict on purpose: a misspelled field must fail loudly instead of being silently dropped
 * into a blob nobody ever reads again.
 */

const optionalText = (max: number) => v.optional(v.pipe(v.string(), v.trim(), v.maxLength(max)))
const optionalUrl = v.optional(v.pipe(v.string(), v.url(), v.maxLength(2048)))
const stringList = (max: number) => v.optional(v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max))))

const projectData = v.strictObject({
  /** What Fran did on the project, as opposed to what the project is. */
  role: optionalText(120),
  client: optionalText(120),
  /** Stack used, rendered as chips by the website. */
  technologies: stringList(60),
  repository_url: optionalUrl,
  demo_url: optionalUrl,
  /** Bullet points worth calling out — impact, scale, an award. */
  highlights: stringList(280),
})

const experienceData = v.strictObject({
  company: optionalText(120),
  position: optionalText(120),
  location: optionalText(120),
  /** e.g. `full-time`, `contract`, `freelance`. Free text: employment vocabulary keeps changing. */
  employment_type: optionalText(60),
  company_url: optionalUrl,
  achievements: stringList(280),
  technologies: stringList(60),
})

const skillData = v.strictObject({
  /** Grouping the website renders skills under, e.g. `backend`, `devops`. */
  category: optionalText(60),
  /** Self-assessed proficiency, 1 to 5. Kept coarse so it stays honest. */
  level: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5))),
  years_of_experience: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(80))),
  /** Icon slug (e.g. a Simple Icons name) the website resolves; not an URL. */
  icon: optionalText(60),
})

const certificationData = v.strictObject({
  issuer: optionalText(120),
  credential_id: optionalText(120),
  /** Public verification link for the credential. */
  credential_url: optionalUrl,
  /** Set when the credential expires; the entry's `ended_at` carries the date itself. */
  expires: v.optional(v.boolean()),
})

const educationData = v.strictObject({
  institution: optionalText(160),
  degree: optionalText(160),
  field: optionalText(160),
  location: optionalText(120),
  institution_url: optionalUrl,
})

type CollectionDefinition = {
  /** Human-readable name, surfaced by `GET /collections` for a CMS UI to label tabs with. */
  name: string
  description: string
  /** Schema of the entry's `data` blob. */
  schema: v.GenericSchema<Record<string, unknown>, Record<string, unknown>>
}

const COLLECTIONS = {
  projects: {
    name: 'Projects',
    description: 'Things Fran has built, shown as the portfolio grid of the landing page.',
    schema: projectData,
  },
  experience: {
    name: 'Experience',
    description: 'Positions held, rendered as the work timeline.',
    schema: experienceData,
  },
  skills: {
    name: 'Skills',
    description: 'Technologies and abilities, grouped by category.',
    schema: skillData,
  },
  certifications: {
    name: 'Certifications',
    description: 'Credentials earned, with their issuer and verification link.',
    schema: certificationData,
  },
  education: {
    name: 'Education',
    description: 'Degrees and formal studies.',
    schema: educationData,
  },
} as const satisfies Record<string, CollectionDefinition>

type CollectionName = keyof typeof COLLECTIONS

const COLLECTION_NAMES = Object.keys(COLLECTIONS) as [CollectionName, ...CollectionName[]]

const isCollection = (value: string): value is CollectionName => value in COLLECTIONS

/** Validates an entry's `data` blob against its collection. Throws a valibot error on mismatch. */
const parseCollectionData = (collection: CollectionName, data: unknown): Record<string, unknown> =>
  v.parse(COLLECTIONS[collection].schema, data ?? {})

export { COLLECTION_NAMES, COLLECTIONS, isCollection, parseCollectionData }
export type { CollectionDefinition, CollectionName }
