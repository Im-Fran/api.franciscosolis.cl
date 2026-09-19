import * as v from 'valibot'

/**
 * What kind of thing a product is, as a closed vocabulary.
 *
 * A registry in code rather than a table, for the reason `src/lib/links.ts` gives for link kinds:
 * the website renders an icon and its own localized label from the key, and a free-form string is a
 * list of icons nobody can finish. Adding a category is a commit here plus an icon there — the same
 * cost as adding a tab, and the same reason to pay it deliberately.
 *
 * A category is **structure, not prose**. Its key is the same fact in every language, so it never
 * enters a `TRANSLATABLE_FIELDS` set; its label is a front-end translation of a registry entry,
 * exactly as a tab's name is.
 */

type CategoryDefinition = {
  /** Label a front-end falls back to before it has its own translation for the category. */
  name: string
  description: string
}

const CATEGORIES = {
  minecraft_plugin: {
    name: 'Minecraft plugin',
    description: 'A plugin or mod for a Minecraft server: Paper, Spigot, Bukkit, Fabric.',
  },
  library: {
    name: 'Libraries / APIs',
    description: 'Something other software is built on rather than something a person runs.',
  },
  cli: {
    name: 'Command line tool',
    description: 'Run from a terminal, scripted more often than clicked.',
  },
  desktop_app: {
    name: 'Desktop app',
    description: 'Installed on a computer: macOS, Windows or Linux.',
  },
  mobile_app: {
    name: 'Mobile app',
    description: 'Installed on a phone or a tablet, or distributed through a store.',
  },
  web_app: {
    name: 'Web app',
    description: 'Hosted and reached in a browser, or self-hosted from a build here.',
  },
  game: {
    name: 'Game',
    description: 'Played rather than used.',
  },
  other: {
    name: 'Other',
    description: 'The escape hatch, the way `other` is for a link kind. Use it rather than a wrong one.',
  },
} as const satisfies Record<string, CategoryDefinition>

type CategoryKey = keyof typeof CATEGORIES

const CATEGORY_KEYS = Object.keys(CATEGORIES) as [CategoryKey, ...CategoryKey[]]

const isCategory = (value: string): value is CategoryKey => value in CATEGORIES

/**
 * Reads a stored category back, or null.
 *
 * Lenient like `parseTabs`: a category retired in a later version of this Worker must degrade to
 * "this product is uncategorised" rather than 500-ing the page it was left on. The write path is
 * strict — see `categoryInput`.
 */
const parseCategory = (raw: string | null): CategoryKey | null => (raw && isCategory(raw) ? raw : null)

/** The category as a response serializes it: the key and the fallback label, never the key alone. */
const describeCategory = (raw: string | null): { key: CategoryKey; name: string } | null => {
  const key = parseCategory(raw)
  return key ? { key, name: CATEGORIES[key].name } : null
}

/** What an editor may send: one of the keys, or an explicit null to clear it. */
const categoryInput = v.optional(v.nullable(v.picklist(CATEGORY_KEYS)))

export { CATEGORIES, CATEGORY_KEYS, categoryInput, describeCategory, isCategory, parseCategory }
export type { CategoryDefinition, CategoryKey }
