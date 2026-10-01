import { describe, expect, it } from 'vitest'
import { CATALOG, NOTIFICATION_TYPES, categoryOf, isEmailable, isNotificationType, renderCopy, resolveLocale } from '@/lib/catalog'
import { CATEGORIES } from '@/lib/config'

describe('the notification catalog', () => {
  it('files every type under the category its prefix names', () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(CATEGORIES).toContain(categoryOf(type))
      expect(type.startsWith(`${categoryOf(type)}.`)).toBe(true)
    }
  })

  it('has copy in both languages for every type', () => {
    for (const entry of Object.values(CATALOG)) {
      expect(entry.copy.en.title.length).toBeGreaterThan(0)
      expect(entry.copy.es.title.length).toBeGreaterThan(0)
    }
  })

  it('never emails what its producer already emails', () => {
    // These producers keep sending their own mail on purpose; emailing them again would be the
    // duplicate this Worker exists to prevent.
    for (const type of [
      'marketplace.purchase_completed',
      'marketplace.purchase_refunded',
    ] as const) {
      expect(isEmailable(type)).toBe(false)
    }
    expect(isEmailable('account.sign_in')).toBe(true)
  })

  it('knows its own types and nothing else', () => {
    expect(isNotificationType('account.sign_in')).toBe(true)
    expect(isNotificationType('account.nope')).toBe(false)
    expect(isNotificationType('toString')).toBe(false)
  })

  it('interpolates the data in the requested language', () => {
    const data = { product_name: 'OpenBattery', amount: '$5.000' }
    expect(renderCopy('marketplace.purchase_completed', data, 'es')).toEqual({
      title: 'Compra confirmada: OpenBattery',
      body: 'Recibimos tu pago de $5.000. Tu comprobante va en camino.',
    })
    expect(renderCopy('marketplace.purchase_completed', data, 'en').title).toBe('Purchase confirmed: OpenBattery')
  })

  it('reads a missing parameter as a dash rather than "undefined"', () => {
    const copy = renderCopy('account.sign_in', { application_name: 'Web', provider_name: 'Google', device: null }, 'en')
    expect(copy.body).toContain('from — · —')
    expect(copy.body).not.toContain('undefined')
  })

  it('names release channels the way a reader says them', () => {
    const data = { product_name: 'Backups', version: '2.0.0', channel: 'release' }
    expect(renderCopy('marketplace.release_published', data, 'en').body).toBe('A new stable release of something you own.')
    expect(renderCopy('marketplace.release_published', data, 'es').body).toBe('Una nueva versión estable de algo que tienes.')
  })

  it('explains a rejected avatar even when no reason was given', () => {
    expect(renderCopy('account.avatar_rejected', { reason: 'Too blurry' }, 'en').body).toBe('Too blurry')
    expect(renderCopy('account.avatar_rejected', { reason: null }, 'es').body).toBe('Puedes subir otra cuando quieras.')
  })

  it('resolves regional and unknown locales', () => {
    expect(resolveLocale('es-CL')).toBe('es')
    expect(resolveLocale('en_GB')).toBe('en')
    expect(resolveLocale('fr')).toBe('en')
    expect(resolveLocale(null)).toBe('en')
  })
})
