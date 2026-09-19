import * as v from 'valibot'

/**
 * How finished a release is, as a closed, ordered vocabulary.
 *
 * This is the same kind of decision as the tab registry and the three pricing modes: a release says
 * *which* of these four it is, and nothing else about its readiness is configurable. A per-product
 * list of channel names would make one product's "beta" mean something different from another's,
 * which is exactly what a house standard exists to prevent.
 *
 * **A channel is not a status.** `draft` / `published` / `archived` decides whether anybody may see
 * the entry at all; the channel decides how much they should trust it. Every release carries both,
 * and the two are independent: a nightly can be published and a stable release can sit in draft.
 *
 * The order is ascending stability, and `stability` restates it as an ordinal so a front-end can
 * render an "or newer" picker without hardcoding the sequence.
 */

const RELEASE_CHANNELS = ['nightly', 'beta', 'rc', 'release'] as const

type ReleaseChannel = (typeof RELEASE_CHANNELS)[number]

type ChannelDefinition = {
  /** Label a front-end falls back to before it has its own translation. */
  name: string
  description: string
  /** Ascending: 0 is the least finished. Lets a UI compare two channels without a lookup table. */
  stability: number
}

const CHANNELS = {
  nightly: {
    name: 'Nightly',
    description: 'Built from the latest commit. Expected to break; published so people can test it.',
    stability: 0,
  },
  beta: {
    name: 'Beta',
    description: 'Feature-complete for the next version, still being found out. Data loss is possible.',
    stability: 1,
  },
  rc: {
    name: 'Release candidate',
    description: 'What the next release will be unless something is found. Only fixes land after this.',
    stability: 2,
  },
  release: {
    name: 'Release',
    description: 'The stable line. This is what the product page offers by default.',
    stability: 3,
  },
} as const satisfies Record<ReleaseChannel, ChannelDefinition>

/**
 * The channel the public feed shows when the caller does not ask for one.
 *
 * Opt-in rather than opt-out: the default view of a product is its stable line, and somebody who
 * wants tonight's build asks for it. All four channels are equally *visible* — what a pre-release
 * may cost is a download, never a page.
 */
const DEFAULT_FEED_CHANNEL: ReleaseChannel = 'release'

/** The channel that is never gated, whatever a product's pre-release setting says. */
const STABLE_CHANNEL: ReleaseChannel = 'release'

const isChannel = (value: string): value is ReleaseChannel =>
  (RELEASE_CHANNELS as readonly string[]).includes(value)

/**
 * Reads a stored channel back, falling back to `release` on anything unknown.
 *
 * Lenient in the same direction as `parsePricingMode`: `release` is the channel that is never
 * gated, so an unreadable value degrades to the build everybody may already have rather than to one
 * that quietly stops being downloadable. The *write* path is strict — see `channelInput`.
 */
const parseChannel = (raw: string | null): ReleaseChannel => (raw && isChannel(raw) ? raw : STABLE_CHANNEL)

/** Whether this channel is one a paid product may put behind its purchase. */
const isPreRelease = (channel: ReleaseChannel): boolean => channel !== STABLE_CHANNEL

/** What an editor may send. Strict: a misspelled channel is a 422, not a silently stable release. */
const channelInput = v.picklist(RELEASE_CHANNELS)

/**
 * What a public feed may ask for. `all` is not a channel — it is the absence of the filter — so it
 * is spelled out here rather than added to `RELEASE_CHANNELS`, where it would become a value a
 * release could be stored as.
 */
const ALL_CHANNELS = 'all'

const channelFilterInput = v.optional(v.picklist([...RELEASE_CHANNELS, ALL_CHANNELS]))

type ChannelFilter = v.InferOutput<typeof channelFilterInput>

/**
 * Turns `?channel=` into the list a query filters on: absent means the stable line only, `all`
 * means no filter, anything else means that one channel.
 *
 * Unknown values never reach here — `channelFilterInput` refuses them, deliberately unlike a tab
 * key. A tab key is content and degrades to one tab fewer; a channel is a *filter*, and a silent
 * fallback would show a visitor pre-release builds they did not ask to see.
 */
const resolveChannelFilter = (filter: ChannelFilter): ReleaseChannel[] | null => {
  if (filter === ALL_CHANNELS) {
    return null
  }
  return [filter ?? DEFAULT_FEED_CHANNEL]
}

export {
  ALL_CHANNELS,
  channelFilterInput,
  channelInput,
  CHANNELS,
  DEFAULT_FEED_CHANNEL,
  isChannel,
  isPreRelease,
  parseChannel,
  RELEASE_CHANNELS,
  resolveChannelFilter,
  STABLE_CHANNEL,
}
export type { ChannelDefinition, ChannelFilter, ReleaseChannel }
