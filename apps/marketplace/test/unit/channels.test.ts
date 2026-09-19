import { describe, expect, it } from 'vitest'
import {
  ALL_CHANNELS,
  CHANNELS,
  DEFAULT_FEED_CHANNEL,
  isChannel,
  isPreRelease,
  parseChannel,
  RELEASE_CHANNELS,
  resolveChannelFilter,
  STABLE_CHANNEL,
} from '@/lib/channels'

describe('the channel registry', () => {
  it('knows exactly the four lines a build can be on, least finished first', () => {
    expect([...RELEASE_CHANNELS]).toEqual(['nightly', 'beta', 'rc', 'release'])
    expect(isChannel('beta')).toBe(true)
    expect(isChannel('canary')).toBe(false)
  })

  it('states the order as an ordinal, so a front-end never hardcodes the sequence', () => {
    const stabilities = RELEASE_CHANNELS.map((channel) => CHANNELS[channel].stability)
    expect(stabilities).toEqual([...stabilities].sort((a, b) => a - b))
    expect(CHANNELS.release.stability).toBeGreaterThan(CHANNELS.nightly.stability)
  })

  it('treats everything but the stable line as a pre-release', () => {
    expect(isPreRelease('nightly')).toBe(true)
    expect(isPreRelease('beta')).toBe(true)
    expect(isPreRelease('rc')).toBe(true)
    expect(isPreRelease(STABLE_CHANNEL)).toBe(false)
  })
})

describe('parseChannel', () => {
  /**
   * The read path is where a channel retired in a later version of this Worker shows up. Falling
   * back to `release` is the direction that grants the least *and* keeps the most: `release` is the
   * one channel a product never gates, so an unreadable value degrades to a build everybody may
   * already have rather than to one that silently stops being downloadable.
   */
  it.each([
    ['null', null],
    ['an empty string', ''],
    ['a retired channel', 'canary'],
    ['something that is not a channel at all', 'true'],
  ])('falls back to the stable channel for %s', (_label, raw) => {
    expect(parseChannel(raw)).toBe('release')
  })

  it('reads back a channel it knows', () => {
    for (const channel of RELEASE_CHANNELS) {
      expect(parseChannel(channel)).toBe(channel)
    }
  })
})

describe('resolveChannelFilter', () => {
  it('shows the stable line and nothing else when nobody asked', () => {
    expect(resolveChannelFilter(undefined)).toEqual([DEFAULT_FEED_CHANNEL])
    expect(DEFAULT_FEED_CHANNEL).toBe('release')
  })

  it('narrows to one channel when one was named', () => {
    expect(resolveChannelFilter('beta')).toEqual(['beta'])
  })

  it('lifts the filter entirely for `all`', () => {
    expect(resolveChannelFilter(ALL_CHANNELS)).toBeNull()
  })

  /** `all` is the absence of a filter, not a fifth channel — a release can never be stored as one. */
  it('keeps `all` out of the set a release may be stored as', () => {
    expect(isChannel(ALL_CHANNELS)).toBe(false)
  })
})
