/**
 * Turns a title into a URL-safe slug: lowercase, accents stripped, everything else collapsed into
 * single dashes. Used when an entry is created without an explicit slug.
 *
 * NFD + combining-marks strip is what handles the Spanish content this CMS mostly holds:
 * "Ingeniería civil" becomes `ingenieria-civil` rather than losing the accented letter entirely.
 */
const slugify = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)

/** Slugs accepted from a client. Deliberately stricter than what `slugify` produces. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/

export { SLUG_PATTERN, slugify }
