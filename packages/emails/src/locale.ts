/**
 * The languages a template can be rendered in.
 *
 * Every template in this package used to be English-only, because every message it sent was
 * transactional plumbing from a service whose own interface is English. Support mail is the first
 * thing here that is *correspondence*: somebody wrote in, in their own language, and answering them
 * in another one is rude in a way a sign-in link never was.
 *
 * The copy for each language is a plain object inside the template, not a lookup through an i18n
 * library. That is deliberate and worth defending: this package ships TypeScript source with no
 * build step, every Worker that imports it bundles it whole, and a runtime i18n dependency would be
 * the first one added to a package whose entire design is "no runtime of its own". Two languages and
 * a handful of strings do not need a framework — and a missing key in an object literal is a type
 * error here, which is better than what a library would give us.
 */
const EMAIL_LOCALES = ['en', 'es'] as const

type EmailLocale = (typeof EMAIL_LOCALES)[number]

/** Falls back to English for anything unrecognised, so a bad locale never blocks a send. */
const resolveEmailLocale = (value: string | null | undefined): EmailLocale =>
  (EMAIL_LOCALES as readonly string[]).includes(value ?? '') ? (value as EmailLocale) : 'en'

export { EMAIL_LOCALES, resolveEmailLocale }
export type { EmailLocale }
