/**
 * Lenient readers for the JSON columns. A malformed value — a hand-edited row, or a column read by a
 * Worker deployed ahead of its migration — degrades to the empty value rather than failing the read.
 */

const parseJsonArray = <T = unknown>(value: string | null | undefined): T[] => {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

const parseJsonObject = <T extends object = Record<string, unknown>>(value: string | null | undefined): T | null => {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : null
  } catch {
    return null
  }
}

/** A `Date` (or null) as the ISO string every response carries. */
const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null)

export { iso, parseJsonArray, parseJsonObject }
