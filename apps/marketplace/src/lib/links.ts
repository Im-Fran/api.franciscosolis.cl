import * as v from 'valibot'

/**
 * The links a product or a release note carries, as a closed vocabulary.
 *
 * `kind` is a key rather than free text because the website renders an icon from it — a store
 * badge, the GitHub mark — and a free-form string is a list of icons nobody can finish. `other`
 * is the escape hatch, and it is the one kind that reads as a plain link with its label.
 *
 * A link is stored as JSON on the row rather than in a table of its own: there are a handful per
 * product, they are always read with it, and they are replaced wholesale on every write.
 */

const LINK_KINDS = [
  'website',
  'github',
  'gitlab',
  'app_store',
  'play_store',
  'download',
  'documentation',
  'discord',
  'support',
  'sponsor',
  'other',
] as const

type LinkKind = (typeof LINK_KINDS)[number]

type ProductLink = {
  kind: LinkKind
  url: string
  /** What the button says. Falls back to the kind's own name on the website when absent. */
  label: string | null
}

/** At most this many links on one row. A banner with thirty buttons under it is not a design. */
const MAX_LINKS = 12

/**
 * What an editor may send. `strictObject` for the same reason the CMS's collection schemas are: a
 * misspelled `lable` must be a 422, not a button that silently never gets a name.
 */
const linkSchema = v.strictObject({
  kind: v.picklist(LINK_KINDS),
  url: v.pipe(v.string(), v.trim(), v.url(), v.maxLength(2048)),
  label: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(80)))),
})

const linkListSchema = v.optional(v.pipe(v.array(linkSchema), v.maxLength(MAX_LINKS)))

type LinkInput = v.InferOutput<typeof linkSchema>

/**
 * Reads the stored blob back into a list, dropping anything malformed instead of throwing. A row
 * whose links blob got corrupted must lose its buttons, not its page.
 */
const parseLinks = (raw: string | null): ProductLink[] => {
  if (!raw) {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) {
    return []
  }

  const links: ProductLink[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue
    }
    const { kind, url, label } = entry as Record<string, unknown>
    if (typeof kind !== 'string' || !(LINK_KINDS as readonly string[]).includes(kind)) {
      continue
    }
    if (typeof url !== 'string' || url.length === 0) {
      continue
    }
    links.push({ kind: kind as LinkKind, url, label: typeof label === 'string' && label.trim() ? label : null })
    if (links.length === MAX_LINKS) {
      break
    }
  }
  return links
}

/** Normalises what an editor sent into what is stored: a blank label becomes an absent one. */
const serializeLinks = (input: readonly LinkInput[] | undefined): string =>
  JSON.stringify(
    (input ?? []).slice(0, MAX_LINKS).map((link) => ({
      kind: link.kind,
      url: link.url,
      label: link.label?.trim() ? link.label.trim() : null,
    })),
  )

export { LINK_KINDS, linkListSchema, linkSchema, MAX_LINKS, parseLinks, serializeLinks }
export type { ProductLink, LinkInput, LinkKind }
