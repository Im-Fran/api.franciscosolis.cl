/**
 * The tabs a product page can show, as a registry.
 *
 * This is the "same company standard" the whole Worker exists to enforce: every product built
 * here gets the same bar under its banner, drawn from the same five tabs, in whatever subset and
 * order the editor picks. A new kind of tab is an entry here plus the route that serves it — never
 * a per-product field describing a layout, which is how a set of pages stops being a standard.
 *
 * `reviews` is what that sentence looks like when it is used: it is a fifth entry plus the routes
 * in `src/routes/reviews.ts`, and nothing else about the registry changed to accommodate it. The
 * Overview *sidebar* is deliberately not a tab — it is chrome beside the banner, like the links
 * row, and the day it becomes a tab key the tab list stops describing what a visitor clicks.
 *
 * `overview` is not in the optional set: a page with no Overview is a banner and a row of links,
 * and every other tab is something a visitor reaches *after* deciding the product is for them.
 * `normalizeTabs` puts it first and keeps it there.
 */

type TabDefinition = {
  /** Label a front-end falls back to before it has its own translation for the tab. */
  name: string
  description: string
  /** Where the tab's content comes from, which is what tells a UI how to edit it. */
  source: 'field' | 'collection'
}

const TABS = {
  overview: {
    name: 'Overview',
    description: 'One centred Markdown document: what the product is, and why anyone would want it.',
    source: 'field',
  },
  releases: {
    name: 'Releases',
    description: 'Release notes, newest first, each with a version, a release date and its store or repository links.',
    source: 'collection',
  },
  wiki: {
    name: 'Wiki',
    description: 'Documentation pages with a sidebar, optionally grouped one level deep under a section.',
    source: 'collection',
  },
  reviews: {
    name: 'Reviews',
    description: 'What the people who bought or downloaded it thought, with the product owner\'s answers.',
    source: 'collection',
  },
  contact: {
    name: 'Contact',
    description: 'How to reach support, as one Markdown document beside the product\'s own links.',
    source: 'field',
  },
} as const satisfies Record<string, TabDefinition>

type TabKey = keyof typeof TABS

const TAB_KEYS = Object.keys(TABS) as [TabKey, ...TabKey[]]

/** The one tab every product has, whatever else it turns on. */
const REQUIRED_TAB: TabKey = 'overview'

const isTab = (value: string): value is TabKey => value in TABS

/**
 * What actually gets stored for a product's `tabs`.
 *
 * Unknown keys are dropped rather than rejected, duplicates collapse, and Overview is forced to the
 * front. Dropping rather than 422-ing matters on the read side: `parseTabs` runs over whatever is
 * in the column, and a tab key retired in a later version of this Worker must degrade to "that page
 * has one tab fewer" instead of 500-ing the product it was left on.
 */
const normalizeTabs = (input: readonly string[] | undefined): TabKey[] => {
  const seen = new Set<TabKey>([REQUIRED_TAB])
  const ordered: TabKey[] = [REQUIRED_TAB]

  for (const value of input ?? []) {
    if (isTab(value) && !seen.has(value)) {
      seen.add(value)
      ordered.push(value)
    }
  }

  return ordered
}

/** Reads the stored blob back into a tab list, falling back to the bare minimum on anything odd. */
const parseTabs = (raw: string | null): TabKey[] => {
  if (!raw) {
    return [REQUIRED_TAB]
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return [REQUIRED_TAB]
  }

  return normalizeTabs(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [])
}

const serializeTabs = (input: readonly string[] | undefined): string => JSON.stringify(normalizeTabs(input))

export { isTab, normalizeTabs, parseTabs, REQUIRED_TAB, serializeTabs, TAB_KEYS, TABS }
export type { TabDefinition, TabKey }
