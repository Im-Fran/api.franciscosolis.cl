import { eq, sql } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { recipients } from '@/db/schema'
import type { Category, EmailFrequency, Locale } from '@/lib/config'
import { CATEGORIES, DEFAULT_EMAIL_FREQUENCY, EMAIL_FREQUENCIES } from '@/lib/config'
import { resolveLocale } from '@/lib/catalog'

/**
 * The per-account half of this Worker: who somebody is, as far as email needs to know, and what
 * they want to hear about.
 */

type ChannelPreferences = { push: boolean; email: boolean }

type Preferences = {
  email_frequency: EmailFrequency
  categories: Record<Category, ChannelPreferences>
  locale: Locale
}

type RecipientRow = typeof recipients.$inferSelect

/** Everything on. Push only does anything once a device subscribes, so "on" costs nobody a thing. */
const DEFAULT_CHANNELS: ChannelPreferences = { push: true, email: true }

/**
 * Reads the stored JSON leniently. A key that is missing, or not a boolean, falls back to the
 * default rather than to `false`: a category added after somebody saved their preferences should
 * arrive switched on, like it would for anybody who never saved any.
 */
const parseCategories = (raw: string | null | undefined): Record<Category, ChannelPreferences> => {
  let stored: Record<string, Partial<ChannelPreferences>> = {}
  try {
    const parsed = JSON.parse(raw ?? '{}')
    if (parsed && typeof parsed === 'object') {
      stored = parsed
    }
  } catch {
    // Garbage in the column is the defaults, not a 500.
  }
  return Object.fromEntries(
    CATEGORIES.map((category) => {
      const entry = stored[category] ?? {}
      return [
        category,
        {
          push: typeof entry.push === 'boolean' ? entry.push : DEFAULT_CHANNELS.push,
          email: typeof entry.email === 'boolean' ? entry.email : DEFAULT_CHANNELS.email,
        },
      ]
    }),
  ) as Record<Category, ChannelPreferences>
}

const parseFrequency = (value: string | null | undefined): EmailFrequency =>
  (EMAIL_FREQUENCIES as readonly string[]).includes(value ?? '') ? (value as EmailFrequency) : DEFAULT_EMAIL_FREQUENCY

const toPreferences = (row: RecipientRow | null | undefined): Preferences => ({
  email_frequency: parseFrequency(row?.emailFrequency),
  categories: parseCategories(row?.categoryPreferences),
  locale: resolveLocale(row?.locale),
})

type RecipientIdentity = {
  userId: string
  email?: string | null
  name?: string | null
  locale?: string | null
}

/**
 * Creates the row, or refreshes what it knows about the account, in one statement.
 *
 * Only fields that were actually supplied overwrite: a producer that knows an account id but not its
 * address must not blank the address another event taught us. Preferences are never touched here —
 * a new row starts from the column defaults, which are the product defaults.
 *
 * The language is a preference too, so a supplied one only *seeds* a new row and never overwrites an
 * existing one. Producers send whatever they happen to hold — a provider's profile locale, the
 * language a support ticket was written in — and letting each event rewrite the column is what made
 * a Spanish reader's notifications flip back to English with the next sign-in. From then on it
 * changes through `PUT /me/preferences` alone, which the website calls with its own language.
 */
const upsertRecipient = async (db: Database, identity: RecipientIdentity) => {
  const email = identity.email?.trim().toLowerCase() || null
  const name = identity.name?.trim() || null
  const locale = identity.locale ? resolveLocale(identity.locale) : null

  await db
    .insert(recipients)
    .values({
      userId: identity.userId,
      email,
      name,
      ...(locale ? { locale } : {}),
    })
    .onConflictDoUpdate({
      target: recipients.userId,
      set: {
        email: sql`coalesce(excluded.email, ${recipients.email})`,
        name: sql`coalesce(excluded.name, ${recipients.name})`,
        updatedAt: sql`(unixepoch())`,
      },
    })
}

const getRecipient = async (db: Database, userId: string) =>
  (await db.select().from(recipients).where(eq(recipients.userId, userId)).get()) ?? null

type PreferencesUpdate = {
  email_frequency?: EmailFrequency
  categories?: Partial<Record<Category, Partial<ChannelPreferences>>>
  locale?: Locale
}

/** Merges a partial update over what is stored, so the website can save one switch at a time. */
const updatePreferences = async (db: Database, userId: string, update: PreferencesUpdate): Promise<Preferences> => {
  const current = toPreferences(await getRecipient(db, userId))
  const categories = { ...current.categories }
  for (const category of CATEGORIES) {
    const change = update.categories?.[category]
    if (change) {
      categories[category] = { ...categories[category], ...change }
    }
  }
  const next: Preferences = {
    email_frequency: update.email_frequency ?? current.email_frequency,
    categories,
    locale: update.locale ?? current.locale,
  }

  await db
    .insert(recipients)
    .values({
      userId,
      emailFrequency: next.email_frequency,
      categoryPreferences: JSON.stringify(next.categories),
      locale: next.locale,
    })
    .onConflictDoUpdate({
      target: recipients.userId,
      set: {
        emailFrequency: next.email_frequency,
        categoryPreferences: JSON.stringify(next.categories),
        locale: next.locale,
        updatedAt: sql`(unixepoch())`,
      },
    })

  return next
}

export { getRecipient, parseCategories, toPreferences, updatePreferences, upsertRecipient }
export type { ChannelPreferences, Preferences, PreferencesUpdate, RecipientIdentity, RecipientRow }
