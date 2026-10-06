import { inArray } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { settings } from '@/db/schema'

/**
 * The settings catalog: every key this Worker reads, what its value means and what it falls back
 * to. The `settings` table stores text, and this is the one place that text is given a type — a row
 * carrying a key that is not listed here is ignored, and so is a value that does not parse.
 *
 * Defaults describe the behaviour this Worker had before the setting existed, so a database missing
 * a row (a fresh one, or one a migration has not reached yet) behaves exactly like the deploy
 * before it rather than picking the more permissive half.
 */
const SETTINGS_CATALOG = {
  /**
   * Whether an address nobody invited may create an account.
   *
   * `false` is the invitation-only behaviour this Worker was built with: an unknown address is
   * refused at both the magic link and the Google tail. `true` opens sign-up to anyone a provider
   * can verify an email address for — which is why Turnstile exists on the endpoints that start a
   * sign-in: opening registration without it opens a mailing endpoint to a script.
   */
  registration_open: { type: 'boolean', default: false },
} as const

type SettingKey = keyof typeof SETTINGS_CATALOG
type AuthSettings = { [K in SettingKey]: boolean }

const SETTING_KEYS = Object.keys(SETTINGS_CATALOG) as SettingKey[]

/** Text as it is stored. Only two spellings are written, and only those two are read back. */
const parseBoolean = (value: string, fallback: boolean) =>
  value === 'true' ? true : value === 'false' ? false : fallback

const serializeBoolean = (value: boolean) => (value ? 'true' : 'false')

const defaults = (): AuthSettings =>
  Object.fromEntries(SETTING_KEYS.map((key) => [key, SETTINGS_CATALOG[key].default])) as AuthSettings

/**
 * Reads every setting in the catalog, filling in the default for one that has no row yet or whose
 * row does not parse. It answers the whole set rather than one key: there are a handful of them,
 * they are read on paths that already touch D1, and a single statement beats one per key.
 */
const getSettings = async (db: Database): Promise<AuthSettings> => {
  const resolved = defaults()
  const rows = await db.select().from(settings).where(inArray(settings.key, SETTING_KEYS))

  for (const row of rows) {
    if ((SETTING_KEYS as string[]).includes(row.key)) {
      resolved[row.key as SettingKey] = parseBoolean(row.value, resolved[row.key as SettingKey])
    }
  }

  return resolved
}

/** Whether an uninvited address may create an account. The one setting the sign-in paths read. */
const isRegistrationOpen = async (db: Database) => (await getSettings(db)).registration_open

/**
 * Writes the settings named in `changes` and answers the resulting set.
 *
 * Upsert rather than update: the row for a key may never have been written, and a setting that only
 * exists once somebody changes it is indistinguishable from one sitting at its default.
 */
const updateSettings = async (
  db: Database,
  changes: Partial<AuthSettings>,
  updatedBy: string | null,
): Promise<AuthSettings> => {
  const now = new Date()

  for (const key of SETTING_KEYS) {
    const value = changes[key]
    if (value === undefined) {
      continue
    }
    await db
      .insert(settings)
      .values({ key, value: serializeBoolean(value), updatedBy, updatedAt: now })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: serializeBoolean(value), updatedBy, updatedAt: now },
      })
  }

  return getSettings(db)
}

export { getSettings, isRegistrationOpen, SETTING_KEYS, SETTINGS_CATALOG, updateSettings }
export type { AuthSettings, SettingKey }
