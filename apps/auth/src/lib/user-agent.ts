/**
 * Turning a `User-Agent` header into something a person recognises.
 *
 * This is deliberately a handful of substring rules and not a parsing library. The string is only
 * ever shown back to the account it belongs to, in a notification whose question is "was this you",
 * and "Chrome on macOS" answers that; a version number does not. Being wrong about an unusual
 * client costs nothing either, because the raw header is what the caller falls back to.
 *
 * Nothing here is a security decision. A user agent is client-controlled and is never read to
 * decide anything — only to describe.
 */

/**
 * Browser rules, in the one order they work in: every Chromium browser also says `Chrome`, Chrome
 * also says `Safari`, and every iOS browser says `Safari` whatever engine it thinks it is. The most
 * specific marker therefore has to be tested first, and the list is read top to bottom.
 */
const BROWSERS: ReadonlyArray<readonly [marker: RegExp, name: string]> = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bVivaldi\//, 'Vivaldi'],
  [/\bBrave\//, 'Brave'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bCriOS\/|\bChrome\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
] as const

/**
 * Platform rules, in their own order: an Android device also says `Linux`, and an iPad in desktop
 * mode says `Macintosh` while still naming itself first.
 */
const PLATFORMS: ReadonlyArray<readonly [marker: RegExp, name: string]> = [
  [/\bWindows NT\b|\bWindows Phone\b/, 'Windows'],
  [/\bAndroid\b/, 'Android'],
  [/\biPhone\b|\biPad\b|\biPod\b/, 'iOS'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b|\bX11\b/, 'Linux'],
] as const

const firstMatch = (rules: ReadonlyArray<readonly [RegExp, string]>, userAgent: string) =>
  rules.find(([marker]) => marker.test(userAgent))?.[1] ?? null

/** How much of an unrecognised header is worth putting in an email. */
const RAW_MAX_LENGTH = 120

/**
 * A short description of the client, or null when there was no header at all.
 *
 * A header neither rule set recognises falls back to the header itself, trimmed: unhelpful to read,
 * but it is still the only description of the device there is, and hiding it would be worse in the
 * one case this exists for.
 */
const describeUserAgent = (userAgent: string | null | undefined): string | null => {
  const value = userAgent?.trim()
  if (!value) {
    return null
  }

  const browser = firstMatch(BROWSERS, value)
  const platform = firstMatch(PLATFORMS, value)

  if (browser && platform) {
    return `${browser} on ${platform}`
  }
  if (browser || platform) {
    return browser ?? platform
  }
  return value.length > RAW_MAX_LENGTH ? `${value.slice(0, RAW_MAX_LENGTH - 1)}…` : value
}

export { describeUserAgent }
