import { inArray } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { settings } from '@/db/schema'

/**
 * The donation link's settings: whether it is open, the smallest and (optionally) largest donation it
 * takes, and whether a donor may leave a message with one.
 *
 * Stored as key/value text in `settings`, the shape `apps/auth` uses for its own: this module is the
 * catalog, the types and the defaults, and a row whose key is not listed here or whose value does not
 * parse is ignored. **The defaults are the link as it shipped** — open, no minimum, no maximum, no
 * messages — so a database a migration has not reached yet behaves exactly like the deploy before it.
 *
 * Every amount is in **whole Chilean pesos**, the currency a donation is charged in, and the bounds
 * are checked against the *converted* charge: ten dollars and ten thousand pesos meet the same floor.
 */
const SETTINGS_CATALOG = {
  donations_enabled: { type: 'boolean', default: true },
  donations_minimum_amount: { type: 'amount', default: null },
  donations_maximum_enabled: { type: 'boolean', default: false },
  /** Kept while the maximum is switched off, so switching it back on does not lose the figure. */
  donations_maximum_amount: { type: 'amount', default: null },
  donations_messages_enabled: { type: 'boolean', default: false },
} as const

type SettingKey = keyof typeof SETTINGS_CATALOG
const SETTING_KEYS = Object.keys(SETTINGS_CATALOG) as SettingKey[]

/** Longest message a donor may leave, in characters. A note, not a letter. */
const DONATION_MESSAGE_MAX = 500

type DonationSettings = {
  enabled: boolean
  /** Smallest charge accepted, in CLP. Null: no minimum beyond one peso. */
  minimum_amount: number | null
  maximum_enabled: boolean
  /** The stored ceiling, whether or not it is in force. See `effectiveMaximum`. */
  maximum_amount: number | null
  messages_enabled: boolean
  /** When and by whom the settings last changed. Null until somebody changes one. */
  updated_at: Date | null
  updated_by: string | null
}

const parseBoolean = (value: string, fallback: boolean) =>
  value === 'true' ? true : value === 'false' ? false : fallback

/** An amount as stored: a positive integer of pesos, or the empty string for "none". */
const parseAmount = (value: string, fallback: number | null): number | null => {
  if (value === '') {
    return null
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : fallback
}

const defaults = (): DonationSettings => ({
  enabled: SETTINGS_CATALOG.donations_enabled.default,
  minimum_amount: SETTINGS_CATALOG.donations_minimum_amount.default,
  maximum_enabled: SETTINGS_CATALOG.donations_maximum_enabled.default,
  maximum_amount: SETTINGS_CATALOG.donations_maximum_amount.default,
  messages_enabled: SETTINGS_CATALOG.donations_messages_enabled.default,
  updated_at: null,
  updated_by: null,
})

/** The ceiling in force: the stored one when it is switched on, and none otherwise. */
const effectiveMaximum = (current: DonationSettings): number | null =>
  current.maximum_enabled ? current.maximum_amount : null

/**
 * Every donation setting, with the default for any key that has no row or whose row does not parse.
 *
 * A read that fails outright — the window in which this deploy has landed and the migration creating
 * `settings` has not — answers the defaults rather than an error: that is exactly the link as it was,
 * and the donation page must not go down for a migration.
 */
const getDonationSettings = async (db: Database): Promise<DonationSettings> => {
  const resolved = defaults()
  let rows: (typeof settings.$inferSelect)[]
  try {
    rows = await db.select().from(settings).where(inArray(settings.key, SETTING_KEYS))
  } catch (error) {
    console.error('donation settings unreadable; using the defaults', error instanceof Error ? error.message : error)
    return resolved
  }

  for (const row of rows) {
    switch (row.key as SettingKey) {
      case 'donations_enabled':
        resolved.enabled = parseBoolean(row.value, resolved.enabled)
        break
      case 'donations_minimum_amount':
        resolved.minimum_amount = parseAmount(row.value, resolved.minimum_amount)
        break
      case 'donations_maximum_enabled':
        resolved.maximum_enabled = parseBoolean(row.value, resolved.maximum_enabled)
        break
      case 'donations_maximum_amount':
        resolved.maximum_amount = parseAmount(row.value, resolved.maximum_amount)
        break
      case 'donations_messages_enabled':
        resolved.messages_enabled = parseBoolean(row.value, resolved.messages_enabled)
        break
    }
    if (!resolved.updated_at || row.updatedAt > resolved.updated_at) {
      resolved.updated_at = row.updatedAt
      resolved.updated_by = row.updatedBy
    }
  }

  return resolved
}

type DonationSettingsChanges = Partial<Pick<
  DonationSettings,
  'enabled' | 'minimum_amount' | 'maximum_enabled' | 'maximum_amount' | 'messages_enabled'
>>

const KEY_FOR: Record<keyof DonationSettingsChanges, SettingKey> = {
  enabled: 'donations_enabled',
  minimum_amount: 'donations_minimum_amount',
  maximum_enabled: 'donations_maximum_enabled',
  maximum_amount: 'donations_maximum_amount',
  messages_enabled: 'donations_messages_enabled',
}

const serialize = (value: boolean | number | null): string =>
  typeof value === 'boolean' ? (value ? 'true' : 'false') : value === null ? '' : String(value)

/**
 * Why a set of settings cannot be saved, or null when it can. Checked on the result of applying the
 * changes, not on the changes alone: a new minimum has to be compared with the maximum already stored.
 */
const checkDonationSettings = (next: DonationSettings): string | null => {
  if (next.maximum_enabled && next.maximum_amount === null) {
    return 'A maximum that is switched on needs an amount'
  }
  const maximum = effectiveMaximum(next)
  if (maximum !== null && next.minimum_amount !== null && next.minimum_amount > maximum) {
    return 'The minimum cannot be larger than the maximum'
  }
  return null
}

/**
 * Applies `changes`, validates the result and writes only the keys that were sent. Answers either the
 * resulting settings or the reason they were refused, so the route decides the status.
 */
const updateDonationSettings = async (
  db: Database,
  changes: DonationSettingsChanges,
  updatedBy: string | null,
): Promise<{ settings: DonationSettings } | { error: string }> => {
  const current = await getDonationSettings(db)
  const next: DonationSettings = { ...current, ...changes }
  const problem = checkDonationSettings(next)
  if (problem) {
    return { error: problem }
  }

  const now = new Date()
  for (const field of Object.keys(changes) as (keyof DonationSettingsChanges)[]) {
    const value = changes[field]
    if (value === undefined) {
      continue
    }
    const key = KEY_FOR[field]
    await db
      .insert(settings)
      .values({ key, value: serialize(value), updatedBy, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: serialize(value), updatedBy, updatedAt: now } })
  }

  return { settings: { ...next, updated_at: now, updated_by: updatedBy } }
}

/** The settings as the back office reads them. */
const toAdminDonationSettings = (current: DonationSettings) => ({
  enabled: current.enabled,
  minimum_amount: current.minimum_amount,
  maximum_enabled: current.maximum_enabled,
  maximum_amount: current.maximum_amount,
  messages_enabled: current.messages_enabled,
  message_max_length: DONATION_MESSAGE_MAX,
  updated_at: current.updated_at?.toISOString() ?? null,
  updated_by: current.updated_by,
})

export {
  checkDonationSettings,
  DONATION_MESSAGE_MAX,
  effectiveMaximum,
  getDonationSettings,
  toAdminDonationSettings,
  updateDonationSettings,
}
export type { DonationSettings, DonationSettingsChanges }
