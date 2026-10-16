import { describe, expect, it } from 'vitest'
import { effectiveState, heartbeatCredit, isConnected } from '@/services/presence'

const at = (iso: string) => new Date(iso)

describe('being connected', () => {
  it('lasts three intervals after the last heartbeat', () => {
    const seen = at('2026-10-15T12:00:00Z')
    expect(isConnected(seen, 60, at('2026-10-15T12:03:00Z'))).toBe(true)
    expect(isConnected(seen, 60, at('2026-10-15T12:03:01Z'))).toBe(false)
  })

  it('is never true for a device that never reported', () => {
    expect(isConnected(null, 60)).toBe(false)
  })
})

describe('the state an installation obeys', () => {
  it('follows the app unless overridden', () => {
    expect(effectiveState('active', null)).toBe('active')
    expect(effectiveState('active', 'maintenance')).toBe('maintenance')
    expect(effectiveState('suspended', 'active')).toBe('active')
  })

  it('reads an unknown value as active rather than locking a device out', () => {
    expect(effectiveState('retired', null)).toBe('active')
  })
})

describe('what a heartbeat credits', () => {
  it('credits the time since the previous heartbeat as online', () => {
    const credit = heartbeatCredit(at('2026-10-15T12:00:00Z'), at('2026-10-15T12:01:00Z'), 60, 45)
    expect(credit).toEqual([{ hourStart: Date.parse('2026-10-15T12:00:00Z') / 1000, onlineSeconds: 60, activeSeconds: 45, heartbeats: 1 }])
  })

  it('splits the credit across the top of an hour, active time in proportion', () => {
    const credit = heartbeatCredit(at('2026-10-15T12:59:30Z'), at('2026-10-15T13:00:30Z'), 60, 60)
    expect(credit).toEqual([
      { hourStart: Date.parse('2026-10-15T12:00:00Z') / 1000, onlineSeconds: 30, activeSeconds: 30, heartbeats: 0 },
      { hourStart: Date.parse('2026-10-15T13:00:00Z') / 1000, onlineSeconds: 30, activeSeconds: 30, heartbeats: 1 },
    ])
  })

  it('credits nothing for a gap longer than the offline threshold, but counts the heartbeat', () => {
    const credit = heartbeatCredit(at('2026-10-15T08:00:00Z'), at('2026-10-15T12:00:10Z'), 60, 600)
    expect(credit).toEqual([{ hourStart: Date.parse('2026-10-15T12:00:00Z') / 1000, onlineSeconds: 0, activeSeconds: 0, heartbeats: 1 }])
  })

  it('credits nothing on the first heartbeat after enrollment without a previous one', () => {
    expect(heartbeatCredit(null, at('2026-10-15T12:00:00Z'), 60, 30)[0]).toMatchObject({ onlineSeconds: 0, activeSeconds: 0, heartbeats: 1 })
  })

  it('never credits more use than time online', () => {
    const [credit] = heartbeatCredit(at('2026-10-15T12:00:00Z'), at('2026-10-15T12:01:00Z'), 60, 5000)
    expect(credit!.activeSeconds).toBe(60)
  })
})
