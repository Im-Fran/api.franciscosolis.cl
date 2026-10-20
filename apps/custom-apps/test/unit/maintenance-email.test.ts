import { formatDuration, renderMaintenanceNoticeEmail, renderMaintenanceRequestEmail, type MaintenanceNoticeStage } from '@franciscosolis/emails'
import { describe, expect, it } from 'vitest'
import { formatMailWindow } from '@/services/mail'

/**
 * The maintenance mail renders inside `workerd`, as it does in production: in both languages, with no
 * `<style>` block a sanitiser would strip, and with the approval link readable in the plain-text part.
 */
const base = { companyName: 'Comercial Andes', appName: 'POS Andes', title: 'Actualización 1.1', description: 'Se instala la 1.1.\nLas cajas muestran un aviso.', estimatedMinutes: 90 }

describe('the maintenance mail', () => {
  it('asks for a window with the link in plain sight, and says when it is the second time', async () => {
    const first = await renderMaintenanceRequestEmail({
      ...base,
      windows: ['martes, 3 de noviembre de 2026, 02:00–03:30 (hora de Santiago)'],
      url: 'https://franciscosolis.cl/mantencion/mnt_example',
      expiresAt: 'martes, 3 de noviembre de 2026, 02:00',
    })
    expect(first.subject).toBe('Elige una ventana para una mantención: “Actualización 1.1”')
    expect(first.html).not.toMatch(/<style/i)
    expect(first.text).toContain('https://franciscosolis.cl/mantencion/mnt_example')
    expect(first.text).toContain('1. martes, 3 de noviembre de 2026, 02:00–03:30 (hora de Santiago)')
    expect(first.text).toContain('Si el botón no funciona')
    expect(first.text).toContain('Las cajas muestran un aviso.')
    const second = await renderMaintenanceRequestEmail({ ...base, windows: ['x'], url: 'https://example.com/mnt', expiresAt: 'y', reminder: true, locale: 'en' })
    expect(second.subject).toBe('Reminder: please choose a window for “Actualización 1.1”')
    expect(second.text).toContain('If the button does not work')
  })

  it.each<MaintenanceNoticeStage>(['approved', 'auto_applied', 'security', 'reminder', 'completed', 'failed'])('renders the %s notice in both languages', async (stage) => {
    for (const locale of ['es', 'en'] as const) {
      const rendered = await renderMaintenanceNoticeEmail({ ...base, stage, window: 'ventana', approvedBy: 'ops@andes.cl', version: '1.1.0', locale })
      expect(rendered.subject).toContain('Actualización 1.1')
      expect(rendered.html).not.toMatch(/<style/i)
      expect(rendered.text).toContain('POS Andes')
    }
  })

  it('says what the devices run after a failure, with or without a release', async () => {
    expect((await renderMaintenanceNoticeEmail({ ...base, stage: 'failed', window: 'w', version: '1.1.0' })).text).toContain('volvieron a la versión que tenían antes')
    expect((await renderMaintenanceNoticeEmail({ ...base, stage: 'failed', window: 'w', version: null })).text).toContain('La app sigue funcionando como antes')
  })

  it('formats durations and windows the way a person says them', () => {
    expect(formatDuration(90)).toBe('1 hora y 30 minutos')
    expect(formatDuration(120, 'en')).toBe('2 hours')
    expect(formatDuration(45)).toBe('45 minutos')
    // 05:00 UTC is 02:00 in Santiago in November (summer time, UTC−3) and 01:00 in July (UTC−4).
    expect(formatMailWindow(new Date('2026-11-03T05:00:00Z'), new Date('2026-11-03T06:30:00Z'), 'es')).toBe('martes, 3 de noviembre de 2026, 02:00–03:30 (hora de Santiago)')
    expect(formatMailWindow(new Date('2026-07-07T05:00:00Z'), new Date('2026-07-07T06:00:00Z'), 'en')).toBe('Tuesday, 7 July 2026, 01:00–02:00 (Santiago time)')
  })
})
