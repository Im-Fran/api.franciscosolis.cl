import type { Category, Locale } from '@/lib/config'
import { DEFAULT_LOCALE, LOCALES } from '@/lib/config'

/**
 * Every kind of notification this service knows, and what it says in each language.
 *
 * The row stores a `type` and the flat `data` the producer sent, never rendered text. That is what
 * lets one notification read in Spanish on the website and in English in a digest for somebody who
 * changed language in between, and it is what keeps a wording fix from being a data migration.
 *
 * `emailable` is the rule that stops the same news arriving twice. Some producers still email on
 * their own, on purpose — a receipt is a document, a support reply is a conversation that can be
 * answered from the inbox — and for those this Worker only keeps the in-site copy and the push.
 * Everything else is this Worker's to email, immediately or in a digest, as the recipient chose.
 *
 * An unknown type is refused at ingest rather than stored with a generic text: a producer sending a
 * type this catalog has never heard of is a deploy-order mistake, and the queue's retries are
 * exactly the mechanism that waits for this Worker to catch up.
 */

type Copy = {
  title: string
  body: string
}

type CatalogEntry = {
  category: Category
  emailable: boolean
  copy: Record<Locale, Copy>
}

const CATALOG = {
  'account.sign_in': {
    category: 'account',
    emailable: true,
    copy: {
      en: {
        title: 'New sign-in to {application_name}',
        body: 'Signed in with {provider_name} from {device} · {location}. Not you? Close the session.',
      },
      es: {
        title: 'Nuevo inicio de sesión en {application_name}',
        body: 'Ingreso con {provider_name} desde {device} · {location}. ¿No fuiste tú? Cierra la sesión.',
      },
    },
  },
  'account.authorization': {
    category: 'account',
    emailable: true,
    copy: {
      en: {
        title: '{application_name} was authorized on your account',
        body: 'Authorized from a browser that was already signed in ({device} · {location}).',
      },
      es: {
        title: 'Se autorizó {application_name} en tu cuenta',
        body: 'Autorizado desde un navegador que ya tenía la sesión iniciada ({device} · {location}).',
      },
    },
  },
  'account.avatar_approved': {
    category: 'account',
    emailable: true,
    copy: {
      en: { title: 'Your new profile picture is live', body: 'It was reviewed and is now shown on your account.' },
      es: { title: 'Tu nueva foto de perfil ya está visible', body: 'Fue revisada y ya se muestra en tu cuenta.' },
    },
  },
  'account.avatar_rejected': {
    category: 'account',
    emailable: true,
    copy: {
      en: { title: 'Your profile picture was not approved', body: '{reason}' },
      es: { title: 'Tu foto de perfil no fue aprobada', body: '{reason}' },
    },
  },
  'support.ticket_reply': {
    category: 'support',
    emailable: false,
    copy: {
      en: { title: 'New reply on {reference}', body: '{author_name} replied to “{subject}”.' },
      es: { title: 'Nueva respuesta en {reference}', body: '{author_name} respondió a “{subject}”.' },
    },
  },
  'support.participant_added': {
    category: 'support',
    emailable: false,
    copy: {
      en: { title: 'You were added to {reference}', body: 'You are now following “{subject}”.' },
      es: { title: 'Te agregaron a {reference}', body: 'Ahora sigues “{subject}”.' },
    },
  },
  'marketplace.purchase_completed': {
    category: 'marketplace',
    emailable: false,
    copy: {
      en: { title: 'Purchase confirmed: {product_name}', body: 'Payment of {amount} received. Your receipt is on its way.' },
      es: { title: 'Compra confirmada: {product_name}', body: 'Recibimos tu pago de {amount}. Tu comprobante va en camino.' },
    },
  },
  'marketplace.purchase_refunded': {
    category: 'marketplace',
    emailable: false,
    copy: {
      en: { title: 'Refund issued: {product_name}', body: '{amount} was refunded.' },
      es: { title: 'Reembolso emitido: {product_name}', body: 'Se reembolsaron {amount}.' },
    },
  },
  'marketplace.release_published': {
    category: 'marketplace',
    emailable: true,
    copy: {
      en: { title: '{product_name} {version} is out', body: 'A new {channel} release of something you own.' },
      es: { title: 'Ya está disponible {product_name} {version}', body: 'Una nueva versión {channel} de algo que tienes.' },
    },
  },
  'marketplace.review_reply': {
    category: 'marketplace',
    emailable: true,
    copy: {
      en: { title: 'Your review of {product_name} got a reply', body: 'The author answered what you wrote.' },
      es: { title: 'Respondieron tu reseña de {product_name}', body: 'El autor respondió lo que escribiste.' },
    },
  },
} as const satisfies Record<string, CatalogEntry>

type NotificationType = keyof typeof CATALOG
const NOTIFICATION_TYPES = Object.keys(CATALOG) as NotificationType[]

const isNotificationType = (value: string): value is NotificationType => Object.hasOwn(CATALOG, value)

const resolveLocale = (value: string | null | undefined): Locale => {
  const base = (value ?? '').toLowerCase().split(/[-_]/)[0]
  return (LOCALES as readonly string[]).includes(base) ? (base as Locale) : DEFAULT_LOCALE
}

/** What a missing parameter reads as. A dash rather than "undefined" or an empty gap in a sentence. */
const MISSING = '—'

type NotificationData = Record<string, string | number | boolean | null>

const interpolate = (template: string, data: NotificationData) =>
  template
    .replace(/\{(\w+)\}/g, (_, key: string) => {
      const value = data[key]
      return value === null || value === undefined || value === '' ? MISSING : String(value)
    })
    .trim()

/**
 * A release channel as a reader says it. `release` is the stable line, and "a new release release"
 * is what the raw key would produce.
 */
const CHANNEL_LABELS: Record<Locale, Record<string, string>> = {
  en: { nightly: 'nightly', beta: 'beta', rc: 'release candidate', release: 'stable' },
  es: { nightly: 'nightly', beta: 'beta', rc: 'candidata', release: 'estable' },
}

const channelLabel = (channel: string, locale: Locale) => CHANNEL_LABELS[locale][channel] ?? channel

/**
 * Title and body for one notification in one language.
 *
 * Plain text, always. `data` is whatever a producer sent — a ticket subject, a product name, an
 * avatar rejection reason an administrator typed — and none of it is ever treated as markup here:
 * the website renders these as text nodes and the email templates escape them like any other prop.
 */
const renderCopy = (type: NotificationType, rawData: NotificationData, locale: Locale): Copy => {
  const copy = CATALOG[type].copy[locale]
  const data = typeof rawData.channel === 'string' ? { ...rawData, channel: channelLabel(rawData.channel, locale) } : rawData
  const title = interpolate(copy.title, data)
  let body = interpolate(copy.body, data)
  // The one type whose body *is* a parameter. A rejection with no reason given would otherwise
  // read as a lone dash, which says less than a sentence admitting there is nothing more to say.
  if (type === 'account.avatar_rejected' && body === MISSING) {
    body = locale === 'es' ? 'Puedes subir otra cuando quieras.' : 'You can upload another one at any time.'
  }
  return { title, body }
}

const categoryOf = (type: NotificationType): Category => CATALOG[type].category
const isEmailable = (type: NotificationType): boolean => CATALOG[type].emailable

export { CATALOG, NOTIFICATION_TYPES, categoryOf, isEmailable, isNotificationType, renderCopy, resolveLocale }
export type { Copy, NotificationData, NotificationType }
