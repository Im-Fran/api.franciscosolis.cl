import { TICKET_REFERENCE_PREFIX } from '@/lib/config'

/**
 * The short, human-readable ticket reference.
 *
 * A UUID is the primary key and a reference is what a person reads out on the phone, types into a
 * subject line and recognises in their inbox. Keeping them as two different things means the id
 * never has to be guessable-proof and the reference never has to be a credential — the access token
 * is what protects the ticket, so a sequential number is fine and a readable one is better.
 */

/** `1042` → `FS-1042`. */
const formatReference = (number: number): string => `${TICKET_REFERENCE_PREFIX}-${number}`

/**
 * Accepts `FS-1042`, `fs-1042` or a bare `1042`, and nothing else.
 *
 * The bare form exists because people type it, and because a route that only accepted the prefixed
 * form would 404 on half the links anybody pastes. Returns null rather than throwing so the caller
 * decides between a 404 and a 422.
 */
const parseReference = (value: string): number | null => {
  const match = new RegExp(`^(?:${TICKET_REFERENCE_PREFIX}-)?(\\d{1,9})$`, 'i').exec(value.trim())
  if (!match) {
    return null
  }
  const number = Number(match[1])
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

/**
 * Finds a ticket reference inside an email subject, e.g. `Re: [FS-1042] Cannot sign in`.
 *
 * This is the weakest link in the threading cascade and the caller must treat it as such: a subject
 * tag is one line for anybody to forge, so a match here is only honoured when the sender is already
 * a participant of that ticket. Without that condition, guessing `[FS-1042]` injects a message into
 * a stranger's thread.
 */
const findReferenceInSubject = (subject: string | null | undefined): number | null => {
  if (!subject) {
    return null
  }
  const match = new RegExp(`\\[${TICKET_REFERENCE_PREFIX}-(\\d{1,9})\\]`, 'i').exec(subject)
  return match ? Number(match[1]) : null
}

/**
 * Removes any `[FS-…]` tag and `Re:`/`RV:` prefixes from a subject.
 *
 * Used when an inbound email becomes a *new* ticket. The subject may already carry a tag — from a
 * stale thread, a forwarded message, or somebody guessing — and the email templates add the real one
 * themselves, so leaving it in produces `[FS-1002] [FS-9999] Cannot sign in`.
 */
const stripReferenceTag = (subject: string): string =>
  subject
    .replace(new RegExp(`\\[${TICKET_REFERENCE_PREFIX}-\\d{1,9}\\]`, 'gi'), '')
    .replace(/^\s*(?:re|rv|fwd|fw)\s*:\s*/gi, '')
    .trim()

export { findReferenceInSubject, formatReference, parseReference, stripReferenceTag }
