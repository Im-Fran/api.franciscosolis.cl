import type { TranslationFormat } from './translate'

/**
 * Whether a field is long-form Markdown or plain text, decided from its name.
 *
 * The same rule the front-end's translation modal uses to pick a control, and it is a rule rather
 * than a list so a service that adds a field needs no wiring in this package: anything ending in
 * `body` is Markdown, everything else — a title, a subtitle, a summary — is plain text.
 */
const formatForField = (field: string): TranslationFormat => (field.endsWith('body') ? 'markdown' : 'plain')

export { formatForField }
export { LANGUAGE_NAMES, languageName } from './languages'
export {
  DEFAULT_TIMEOUT_MS,
  MAX_SOURCE_CHARS,
  parseAnswer,
  systemPrompt,
  translate,
  TRANSLATION_JSON_SCHEMA,
} from './translate'
export type { ModelRunner, TranslateRequest, TranslationFormat } from './translate'
