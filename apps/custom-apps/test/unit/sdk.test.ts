import { describe, expect, it } from 'vitest'
import { renderSdk } from '@/services/sdk'

const config = {
  appId: '0b1c6f5e-2f0a-4b36-9b1e-7d3c2a1f0e9d',
  appKey: 'cak_example',
  baseUrl: 'https://ingest.franciscosolis.cl/custom-apps/v1/0b1c6f5e-2f0a-4b36-9b1e-7d3c2a1f0e9d',
  intervalSeconds: 60,
  modules: ['events', 'metrics'] as Array<'events' | 'metrics'>,
}

describe('the website SDK', () => {
  it('is byte-for-byte deterministic, so an integrity hash can pin it', () => {
    expect(renderSdk(config)).toBe(renderSdk({ ...config, modules: ['metrics', 'events'] }))
  })

  it('bakes in the app, its key, its base URL and its modules', () => {
    const script = renderSdk(config)
    expect(script).toContain(JSON.stringify(config.appKey))
    expect(script).toContain(JSON.stringify(config.baseUrl))
    expect(script).toContain('"modules":["events","metrics"]')
  })

  it('changes when the configuration does', () => {
    expect(renderSdk(config)).not.toBe(renderSdk({ ...config, intervalSeconds: 30 }))
    expect(renderSdk(config)).not.toBe(renderSdk({ ...config, appKey: 'cak_other' }))
  })

  it('parses as JavaScript', () => {
    // `new Function` compiles without running it; a syntax error in the template throws here.
    expect(() => new Function(renderSdk(config))).not.toThrow()
  })
})
