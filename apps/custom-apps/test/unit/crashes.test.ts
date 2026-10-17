import { describe, expect, it } from 'vitest'
import { crashSignature, crashTitle, normaliseStack } from '@/services/telemetry'

describe('crash signatures', () => {
  it('take out addresses, line numbers and numbered closures', () => {
    expect(normaliseStack('   0: 0x7ff6a1b2 - pos::printer::print\n             at src/printer.rs:42:17')).toBe('N: <addr> - pos::printer::print\nat src/printer.rs')
    expect(normaliseStack('TypeError: x is undefined\n    at render (https://shop.cl/app.js:1:2345)\n    at {closure#12}')).toBe(
      'TypeError: x is undefined\nat render (https://shop.cl/app.js)\nat {closure#N}',
    )
  })

  it('keep only the top frames, so a deep stack groups by where it broke', () => {
    const top = Array.from({ length: 12 }, (_, index) => `at frame${String.fromCharCode(97 + index)}`).join('\n')
    expect(normaliseStack(`${top}\nat main`)).toBe(normaliseStack(`${top}\nat other_entry_point`))
  })

  it('group the same panic from two builds, and tell two panics apart', async () => {
    const a = await crashSignature({ kind: 'panic', message: 'boom', stack: 'at a.rs:1:1\nat b.rs:2:2' })
    const b = await crashSignature({ kind: 'panic', message: 'boom again', stack: 'at a.rs:9:9\nat b.rs:8:8' })
    const c = await crashSignature({ kind: 'panic', message: 'boom', stack: 'at c.rs:1:1' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('fall back on the message for a report with no stack', async () => {
    expect(await crashSignature({ kind: 'SIGSEGV', message: 'fault at 0x10', stack: null })).toBe(await crashSignature({ kind: 'SIGSEGV', message: 'fault at 0x20', stack: '' }))
  })

  it('are titled by kind and first line', () => {
    expect(crashTitle({ kind: 'panic', message: 'first\nsecond' })).toBe('panic: first')
    expect(crashTitle({ kind: null, message: null })).toBe('Crash')
    expect(crashTitle({ kind: 'E', message: 'x'.repeat(300) })).toHaveLength(200)
  })
})
