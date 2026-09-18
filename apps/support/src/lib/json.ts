/**
 * Reading a JSON column back.
 *
 * Never throws, for the same reason `parseTranslations` does not: a blob that got corrupted must
 * cost that row the one field, not take the whole listing down with it. Every JSON column in this
 * schema is read through here.
 */
const parseJson = <T>(raw: string | null, fallback: T): T => {
  if (!raw) {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export { parseJson }
