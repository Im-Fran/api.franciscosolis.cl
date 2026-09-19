import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, seedProduct, seedRelease } from '../helpers/db'

const get = (path: string) => SELF.fetch(`https://marketplace.test${path}`)

const body = async <T>(path: string): Promise<T> => ((await (await get(path)).json()) as { data: T }).data

type Row = { version: string; channel: string }

/** One product with the same version on two lines, plus a nightly of its own. */
const seedLines = async () => {
  const product = await seedProduct({ slug: 'openbattery', name: 'OpenBattery' })
  await seedRelease({ productId: product.id, version: '2.6.4', channel: 'release', releasedAt: new Date('2026-01-10') })
  await seedRelease({ productId: product.id, version: '2.7.0', channel: 'rc', releasedAt: new Date('2026-02-01') })
  await seedRelease({ productId: product.id, version: '2.7.0', channel: 'beta', releasedAt: new Date('2026-01-20') })
  await seedRelease({ productId: product.id, version: '2.8.0', channel: 'nightly', releasedAt: new Date('2026-02-10') })
  return product
}

describe('GET /products/:slug/releases', () => {
  beforeEach(clearDatabase)

  /**
   * The opt-in the whole channel model turns on: the default view of a product is what it ships.
   * Somebody who wants tonight's build asks for it by name.
   */
  it('shows the stable line and nothing else when no channel was asked for', async () => {
    await seedLines()

    const rows = await body<Row[]>('/products/openbattery/releases')

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ version: '2.6.4', channel: 'release' })
  })

  it('narrows to one channel when one was named', async () => {
    await seedLines()

    const rows = await body<Row[]>('/products/openbattery/releases?channel=beta')

    expect(rows.map((row) => row.version)).toEqual(['2.7.0'])
    expect(rows[0]?.channel).toBe('beta')
  })

  it('lifts the filter for `all`, newest release first', async () => {
    await seedLines()

    const rows = await body<Row[]>('/products/openbattery/releases?channel=all')

    expect(rows.map((row) => `${row.channel}:${row.version}`)).toEqual([
      'nightly:2.8.0',
      'rc:2.7.0',
      'beta:2.7.0',
      'release:2.6.4',
    ])
  })

  /**
   * A tab key degrades to one tab fewer; a channel is a *filter*, and a typo that silently became
   * `all` would put nightlies in front of somebody who never asked for one.
   */
  it('refuses an unknown channel instead of falling back to one', async () => {
    await seedLines()

    expect((await get('/products/openbattery/releases?channel=canary')).status).toBe(400)
  })

  it('shows a pre-release to anybody: the gate is on the download, not on the page', async () => {
    const product = await seedProduct({
      slug: 'openbattery',
      pricingMode: 'paid',
      priceAmount: 4990,
      preReleaseRequiresPurchase: true,
    })
    await seedRelease({ productId: product.id, version: '3.0.0-beta', channel: 'beta' })

    const rows = await body<Row[]>('/products/openbattery/releases?channel=beta')

    expect(rows.map((row) => row.version)).toEqual(['3.0.0-beta'])
  })
})

describe('GET /products/:slug/releases/:channel/:version', () => {
  beforeEach(clearDatabase)

  /**
   * The channel is part of the address because it is part of the key. A lookup by version alone
   * would answer with whichever row SQLite reached first — and the one it reached could be the
   * gated one.
   */
  it('resolves the right row when one version exists on two channels', async () => {
    await seedLines()

    expect((await body<Row>('/products/openbattery/releases/rc/2.7.0')).channel).toBe('rc')
    expect((await body<Row>('/products/openbattery/releases/beta/2.7.0')).channel).toBe('beta')
  })

  it('is a 404 on a channel that version was never published on', async () => {
    await seedLines()

    expect((await get('/products/openbattery/releases/release/2.7.0')).status).toBe(404)
  })

  it('refuses a channel that is not one', async () => {
    await seedLines()

    expect((await get('/products/openbattery/releases/canary/2.7.0')).status).toBe(400)
  })

  it('does not exist for a draft release, on any channel', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    await seedRelease({ productId: product.id, version: '9.9.9', channel: 'nightly', status: 'draft' })

    expect((await get('/products/openbattery/releases/nightly/9.9.9')).status).toBe(404)
  })
})

describe('the channel is part of the version key', () => {
  beforeEach(clearDatabase)

  it('lets the same version exist as an rc and later as a release', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    await seedRelease({ productId: product.id, version: '2.7.0', channel: 'rc' })
    await seedRelease({ productId: product.id, version: '2.7.0', channel: 'release' })

    const rows = await body<Row[]>('/products/openbattery/releases?channel=all')
    expect(rows).toHaveLength(2)
  })
})
