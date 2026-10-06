import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { getDb } from '@/db/client'
import { settings } from '@/db/schema'
import { getSettings, isRegistrationOpen, SETTING_KEYS, updateSettings } from '@/services/settings'
import { createUser, db } from '../helpers/db'

/** Puts a raw row in the table, which is the only way to test what a hand-edited value does. */
const writeRaw = async (key: string, value: string) => {
  await env.DB.prepare('INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON CONFLICT(`key`) DO UPDATE SET `value` = ?')
    .bind(key, value, value)
    .run()
}

describe('getSettings', () => {
  it('reads the seeded value, which is the behaviour this Worker had before the setting existed', async () => {
    await expect(getSettings(db())).resolves.toEqual({ registration_open: false })
  })

  it('falls back to the default when the row is missing entirely', async () => {
    await env.DB.prepare('DELETE FROM settings').run()

    await expect(getSettings(db())).resolves.toEqual({ registration_open: false })

    await writeRaw('registration_open', 'false')
  })

  it('falls back to the default for a value that is not one of the two spellings', async () => {
    await writeRaw('registration_open', 'yes please')

    await expect(isRegistrationOpen(db())).resolves.toBe(false)

    await writeRaw('registration_open', 'false')
  })

  it('ignores a row whose key is not in the catalog', async () => {
    await writeRaw('something_else', 'true')

    const resolved = await getSettings(db())

    expect(Object.keys(resolved)).toEqual(SETTING_KEYS)
  })
})

describe('updateSettings', () => {
  it('writes a value, stamps who wrote it and answers the whole set', async () => {
    const actor = await createUser()

    const after = await updateSettings(db(), { registration_open: true }, actor.id)

    expect(after).toEqual({ registration_open: true })
    await expect(isRegistrationOpen(db())).resolves.toBe(true)

    const [row] = await getDb(env).select().from(settings).where(eq(settings.key, 'registration_open'))
    expect(row).toMatchObject({ value: 'true', updatedBy: actor.id })

    await updateSettings(db(), { registration_open: false }, actor.id)
  })

  it('leaves a key the caller did not name alone', async () => {
    await updateSettings(db(), { registration_open: true }, null)

    await expect(updateSettings(db(), {}, null)).resolves.toEqual({ registration_open: true })

    await updateSettings(db(), { registration_open: false }, null)
  })

  it('writes the row even when the table never had one for that key', async () => {
    await env.DB.prepare('DELETE FROM settings').run()

    await expect(updateSettings(db(), { registration_open: true }, null)).resolves.toEqual({ registration_open: true })

    await updateSettings(db(), { registration_open: false }, null)
  })
})
