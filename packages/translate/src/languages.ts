/**
 * The languages this monorepo can translate between, by BCP-47 primary subtag.
 *
 * The names are in English and that is deliberate: they go into a prompt, not into a user
 * interface. A model asked to "translate to Español" answers about as well as one asked to
 * translate to "Spanish", but only one of the two is a phrase every text model has seen a million
 * times in its instruction data. The front-end has its own, localised list for the labels a human
 * reads.
 *
 * A locale absent from here is not a failure: `languageName` falls back to the tag itself, which
 * still reads as an instruction ("translate to pt-BR") and keeps a service that adds a locale from
 * having to land a change in this package first.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  pt: 'Portuguese',
  fr: 'French',
  de: 'German',
  it: 'Italian',
}

const languageName = (locale: string): string => LANGUAGE_NAMES[locale.toLowerCase().split('-')[0] ?? ''] ?? locale

export { LANGUAGE_NAMES, languageName }
