/**
 * `@mentions` inside a ticket message body.
 *
 * A ticket message is plain text end to end — see `apps/support/CLAUDE.md` on why there is no
 * column for HTML anywhere near one — so a mention is written as `@` immediately followed by an
 * email address (`@fran@franciscosolis.cl`), which reads fine as plain text on its own and is
 * turned into a `mailto:` link only here, at render time. The website carries its own copy of this
 * exact pattern for the console's timeline (`src/lib/support/mentions.ts` in that repository); the
 * two cannot share code across repos, so keep them in step by hand if the pattern ever changes.
 */
const MENTION_PATTERN = /@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g

type MentionPart = { kind: 'text'; value: string } | { kind: 'mention'; email: string }

/** Splits a message body into plain-text runs and mentioned addresses, in order. */
const splitMentions = (text: string): MentionPart[] => {
  const parts: MentionPart[] = []
  let last = 0

  for (const match of text.matchAll(MENTION_PATTERN)) {
    const index = match.index ?? 0
    if (index > last) parts.push({ kind: 'text', value: text.slice(last, index) })
    parts.push({ kind: 'mention', email: match[1]! })
    last = index + match[0].length
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) })

  return parts
}

export { splitMentions }
export type { MentionPart }
