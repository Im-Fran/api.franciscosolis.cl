import type { EmailLocale } from './locale'

/**
 * An amount as a receipt has to print it.
 *
 * Every amount this monorepo charges is an integer of the currency's major unit — CLP has no minor
 * unit, so 1990 is 1990 pesos and never 19.90 (see `apps/marketplace/src/lib/pricing.ts`). That is why
 * `maximumFractionDigits` is pinned to zero rather than left to the locale: `Intl` would otherwise
 * print `$1.990,00` for a currency that cannot express cents, and a receipt showing decimals on a
 * peso amount is the kind of thing somebody asks about.
 *
 * `Intl.NumberFormat` is part of the `workerd` runtime, so this needs no dependency and no polyfill.
 * A currency the runtime does not recognise falls back to `<code> <amount>`, which is still readable
 * — an exception thrown while rendering a receipt would lose the whole message.
 */
const formatMoney = (amount: number, currency: string, locale: EmailLocale = 'en'): string => {
  try {
    return new Intl.NumberFormat(locale === 'es' ? 'es-CL' : 'en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    }).format(amount)
  } catch {
    return `${currency} ${amount}`
  }
}

export { formatMoney }
