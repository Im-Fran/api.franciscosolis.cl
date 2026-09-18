import { BODY_LIMITS } from '@/lib/config'

/**
 * Turning an inbound email into the plain text a ticket stores.
 *
 * Two jobs, both of which have to be done here rather than anywhere downstream.
 *
 * **HTML never survives this file.** A support thread is the most thoroughly unauthenticated input
 * this monorepo handles, and `packages/emails/CLAUDE.md` is explicit that nothing unauthenticated
 * may reach `ContentEmail`'s `dangerouslySetInnerHTML`. The schema has no column for HTML at all, so
 * an HTML-only message is converted here or it is not stored.
 *
 * **The quoted trail is cut off.** Without that, message *n* in a thread contains all of messages
 * 1..n-1: storage grows quadratically, every digest quotes the entire history back at the person who
 * wrote it, and an agent scrolling a long ticket reads the same paragraph nine times. The untrimmed
 * body is kept beside it in `body_text_raw`, so a trim that took too much is recoverable rather than
 * lost — which is the only reason it is safe to be aggressive about it.
 *
 * There is deliberately no dependency for either. `html-to-text` does arrive transitively through
 * `@react-email/render`, but it is not a public export of `@franciscosolis/emails` and reaching into
 * it would tie the inbound path to a detail of how outbound mail is rendered.
 */

/** Elements that end a block of prose, and therefore a blank line. */
const BLOCK_CLOSERS = /<\/(?:p|div|h[1-6]|blockquote|section|article)\s*>/gi
/** Elements that end a line but not a block. A table row is a line; a list item opens its own. */
const ROW_CLOSERS = /<\/(?:tr|li)\s*>/gi
const LINE_BREAKS = /<br\s*\/?>/gi
const DROPPED_ELEMENTS = /<(script|style|head|noscript)[\s\S]*?<\/\1\s*>/gi
const TAGS = /<[^>]+>/g

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

const decodeEntities = (value: string): string =>
  value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)

/** A readable plain-text rendering of an HTML mail body. Not a general-purpose converter. */
const htmlToText = (html: string): string =>
  decodeEntities(
    html
      .replace(DROPPED_ELEMENTS, ' ')
      .replace(LINE_BREAKS, '\n')
      // The opener carries the bullet and the newline, so the closer must not add another.
      .replace(ROW_CLOSERS, '')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(BLOCK_CLOSERS, '\n\n')
      .replace(TAGS, ''),
  )
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/**
 * Where the reply ends and the quoted history begins.
 *
 * Every pattern here is something a real mail client emits, in English or Spanish, and each one is
 * covered by a fixture in the suite. Matching is on the *earliest* hit, because a message can carry
 * several of them and the first is where the person stopped writing.
 */
const QUOTE_MARKERS: RegExp[] = [
  // Gmail and Apple Mail: "On 3 Jan 2026, at 14:02, Someone <a@b> wrote:"
  /^On .{0,200}\bwrote:\s*$/m,
  // The same in Spanish: "El 3 ene 2026, a las 14:02, Alguien escribió:"
  /^El .{0,200}\bescribió:\s*$/m,
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^-{2,}\s*Mensaje original\s*-{2,}/im,
  /^-{2,}\s*Forwarded message\s*-{2,}/im,
  // Outlook's separator, then its header block.
  /^_{10,}\s*$/m,
  /^From:\s.+\n(?:Sent|To|Subject):\s/m,
  /^De:\s.+\n(?:Enviado|Para|Asunto):\s/m,
  // The RFC 3676 signature delimiter: a line that is exactly "-- ".
  /^-- $/m,
]

const trimQuotedReply = (text: string): string => {
  let cut = text.length

  for (const marker of QUOTE_MARKERS) {
    const match = marker.exec(text)
    if (match && match.index < cut) {
      cut = match.index
    }
  }

  let trimmed = text.slice(0, cut)

  // A trailing run of `>` quoting, which every client produces and none of the markers above
  // announces. Removed from the end only: a `>` in the middle of a message is somebody quoting a
  // line on purpose.
  const lines = trimmed.split('\n')
  while (lines.length > 0) {
    const last = lines[lines.length - 1] ?? ''
    if (last.trim() === '' || last.startsWith('>')) {
      lines.pop()
      continue
    }
    break
  }
  trimmed = lines.join('\n').trim()

  // Never return nothing. A message that is *entirely* quoted text — somebody replying with only
  // "see below" stripped by their client, or a forward with no comment — is still a message, and an
  // empty ticket entry is worse than a redundant one.
  return trimmed.length > 0 ? trimmed : text.trim()
}

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max)}\n\n[truncated]`

type ParsedBody = {
  /** What the ticket stores and the console shows. */
  text: string
  /** The untrimmed original, kept so a bad trim is recoverable. Null when nothing was cut. */
  raw: string | null
}

/**
 * The whole pipeline: prefer the text part, fall back to converting the HTML one, trim the quoted
 * trail, and cap both at the ceilings in `BODY_LIMITS`.
 */
const readBody = (input: { text?: string | null; html?: string | null }): ParsedBody => {
  const source = (input.text?.trim() || (input.html ? htmlToText(input.html) : '')).replace(/\r\n?/g, '\n')
  const trimmed = trimQuotedReply(source)

  return {
    text: truncate(trimmed, BODY_LIMITS.message),
    raw: trimmed === source ? null : truncate(source, BODY_LIMITS.messageRaw),
  }
}

export { htmlToText, readBody, trimQuotedReply }
export type { ParsedBody }
