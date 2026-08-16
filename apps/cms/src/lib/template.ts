/**
 * Minimal `{{ variable }}` interpolation for email templates.
 *
 * Not a template engine on purpose: no conditionals, no loops, no partials, no expression
 * evaluation. Editors write mail, not programs, and anything richer would mean shipping a
 * user-supplied-code evaluator inside a Worker that can send mail from a real domain.
 */

/** Matches `{{ name }}`, tolerating surrounding whitespace. Names are `[a-zA-Z0-9_]`. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

/** Every distinct placeholder name used in a string, in first-seen order. */
const extractVariables = (template: string): string[] => {
  const found = new Set<string>()
  for (const match of template.matchAll(PLACEHOLDER)) {
    found.add(match[1] as string)
  }
  return [...found]
}

/**
 * Replaces every placeholder with its value. Values are inserted verbatim: an HTML body is
 * authored by an editor who already controls the whole document, and escaping here would corrupt
 * intentional markup such as a link. Callers that interpolate untrusted text must escape it first.
 */
const render = (template: string, values: Record<string, string>): string =>
  template.replace(PLACEHOLDER, (_match, name: string) => values[name] ?? '')

/** Placeholder names present in the template but missing from `values`. */
const missingVariables = (template: string, values: Record<string, string>): string[] =>
  extractVariables(template).filter((name) => values[name] === undefined)

/** Escapes text before it is interpolated into an HTML email body. */
const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

export { escapeHtml, extractVariables, missingVariables, render }
