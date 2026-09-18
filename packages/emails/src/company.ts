/**
 * Who sends these emails, as the law requires them to be identified.
 *
 * Every message this monorepo sends is transactional mail from a company, and the footer is the
 * only place in it that says which one. That is not decoration: a recipient looking at a sign-in
 * notice or an invitation is entitled to know the legal entity behind it, at what address, and
 * where its terms and privacy policy are — without having to reply and ask.
 *
 * These values mirror `src/lib/company.ts` in the website repository (`franciscosolis.cl`), which
 * is where the footer, the legal pages and the JSON-LD read them from. The two files are separate
 * repositories and cannot import from each other, so they are kept in sync by hand: an address or
 * a RUT that changes here changes there in the same breath. A discrepancy between the address in
 * an email and the one on the legal page is exactly the sort of thing that later has to be
 * explained.
 *
 * `LEGAL_NAME` is written unaccented and in upper case because that is how it is inscribed in the
 * register. It is not a typo to "fix", and it is not translated in the Spanish reading of a page
 * either — a razón social is one string in every language.
 */

/** The registered legal name, verbatim from the register. */
const LEGAL_NAME = 'DESARROLLO Y MANTENCION DE SERVICIOS INFORMATICOS FRANCISCO SOLIS MATURANA E.I.R.L.'

/** The name the company presents itself under. The brand, not the legal entity. */
const TRADE_NAME = 'FranciscoSolis'

/** The Chilean taxpayer id, dotted and hyphenated — the way it is read there, not normalised. */
const RUT = '78.473.345-9'

/** The commercial address, on one line, the same shape the website's footer prints. */
const ADDRESS_LINE = 'Av. Irarrázaval 2401, Oficina 607, Ñuñoa, Santiago, Chile'

/** Where privacy rights are exercised and legal questions are answered. */
const CONTACT_EMAIL = 'fsolism@franciscosolis.cl'

const WEBSITE = 'https://franciscosolis.cl'

/** Shown without the scheme; the footer links it to `WEBSITE`. */
const WEBSITE_LABEL = 'franciscosolis.cl'

/**
 * The legal documents, addressed by the slug the CMS publishes them under.
 *
 * The website serves every legal document from one `/legal` route and selects between them by the
 * fragment, so these are `#<slug>` links rather than separate paths. The slugs are the ones seeded
 * in `apps/cms/migrations/0001_seed_landing_content.sql`; renaming one there breaks these links.
 */
const TERMS_URL = `${WEBSITE}/legal#terms-of-service`
const PRIVACY_URL = `${WEBSITE}/legal#privacy-policy`

/** Everything at once, for a component that would rather take one import than eight. */
const company = {
  legalName: LEGAL_NAME,
  tradeName: TRADE_NAME,
  rut: RUT,
  addressLine: ADDRESS_LINE,
  email: CONTACT_EMAIL,
  website: WEBSITE,
  websiteLabel: WEBSITE_LABEL,
  termsUrl: TERMS_URL,
  privacyUrl: PRIVACY_URL,
} as const

export {
  ADDRESS_LINE,
  company,
  CONTACT_EMAIL,
  LEGAL_NAME,
  PRIVACY_URL,
  RUT,
  TERMS_URL,
  TRADE_NAME,
  WEBSITE,
  WEBSITE_LABEL,
}
