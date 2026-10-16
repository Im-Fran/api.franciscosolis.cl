import type { TargetScope } from '@/lib/config'

/**
 * Who a flag or a message is aimed at: the whole app, one channel, or one installation.
 *
 * Shared by flags and messages so the two can never disagree about what "aimed at the beta channel"
 * means. Where several rows apply to one device (a flag set app-wide and overridden for one kiosk),
 * the most specific wins: installation, then channel, then app.
 */

type Targeted = { scope: string; scopeValue: string }
type DeviceTarget = { id: string; channel: string }

const SPECIFICITY: Record<TargetScope, number> = { app: 0, channel: 1, installation: 2 }

/** Whether a row applies to a device. A scope this version does not know applies to nobody. */
const appliesTo = (row: Targeted, device: DeviceTarget) =>
  row.scope === 'app' ||
  (row.scope === 'channel' && row.scopeValue === device.channel) ||
  (row.scope === 'installation' && row.scopeValue === device.id)

const specificity = (row: Targeted) => SPECIFICITY[row.scope as TargetScope] ?? -1

/** `scope_value` as stored: `''` for the app scope, the channel or installation id otherwise. */
const storedScopeValue = (scope: TargetScope, value: string | null | undefined) => (scope === 'app' ? '' : (value ?? ''))

export { appliesTo, specificity, storedScopeValue }
export type { DeviceTarget, Targeted }
