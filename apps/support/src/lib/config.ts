/** Where a ticket can be in its life. `spam` is terminal and invisible to the requester. */
const TICKET_STATUS = ['new', 'open', 'pending', 'on_hold', 'solved', 'closed', 'spam'] as const
type TicketStatus = (typeof TICKET_STATUS)[number]

/** Statuses a requester is allowed to see. `spam` is not one of them. */
const REQUESTER_VISIBLE_STATUS = TICKET_STATUS.filter((status) => status !== 'spam')

const TICKET_PRIORITY = ['low', 'normal', 'high', 'urgent'] as const
type TicketPriority = (typeof TICKET_PRIORITY)[number]

/** How a ticket got here. */
const TICKET_SOURCE = ['web', 'email', 'agent'] as const
type TicketSource = (typeof TICKET_SOURCE)[number]

/**
 * `reply` is part of the conversation; `note` never leaves the support team.
 *
 * This is the one field in this Worker where a bug is a data breach rather than a glitch, which is
 * why the redaction lives in exactly one function (`toRequesterTimeline`) instead of being repeated
 * per route.
 */
const MESSAGE_KIND = ['reply', 'note'] as const
type MessageKind = (typeof MESSAGE_KIND)[number]

const AUTHOR_TYPE = ['requester', 'agent', 'system'] as const
type AuthorType = (typeof AUTHOR_TYPE)[number]

const PARTICIPANT_ROLE = ['requester', 'agent', 'cc'] as const
type ParticipantRole = (typeof PARTICIPANT_ROLE)[number]

/** Closed vocabulary for `ticket_events.event`, so the console can render each one. */
const TICKET_EVENTS = [
  'created',
  'status_changed',
  'priority_changed',
  'subject_changed',
  'assigned',
  'unassigned',
  'label_added',
  'label_removed',
  'participant_added',
  'participant_removed',
  'claimed',
  'link_rotated',
  'notification_sent',
  'inbound_rejected',
  'reopened',
] as const
type TicketEvent = (typeof TICKET_EVENTS)[number]

/** Publication states for help centre content, matching the CMS and pages Workers. */
const CONTENT_STATUS = ['draft', 'published', 'archived'] as const
type ContentStatus = (typeof CONTENT_STATUS)[number]

/**
 * Permissions this Worker enforces, granted by `apps/auth` against the `franciscosolis-support`
 * client application.
 *
 * `apps/support` is the first Worker in this monorepo to check `permissions` at all — see the long
 * note on `requireAgent` in `src/middleware/auth.ts` for why a support system cannot get away with
 * the email-domain check the cms and pages Workers stop at.
 */
const AGENT_PERMISSION = 'support:agent'

/** Reshaping the service rather than answering a ticket: labels, help articles, the assistant. */
const ADMIN_PERMISSION = 'support:admin'

/** How long a fetched JWKS is reused before the auth Worker is asked again, in seconds. */
const JWKS_CACHE_TTL = 3600

/** Listing bounds shared by every paginated route. */
const PAGINATION = {
  defaultLimit: 50,
  maxLimit: 200,
} as const

/** Ceilings on stored text, in characters. */
const BODY_LIMITS = {
  /** One message on a ticket, after the quoted trail is trimmed. */
  message: 64_000,
  /** The untrimmed inbound body kept beside it, so a bad trim is recoverable. */
  messageRaw: 256_000,
  /** One help article. */
  article: 200_000,
  subject: 200,
} as const

/** The deferred-reply rule, in one place. */
const NOTIFICATIONS = {
  /**
   * How long a requester gets to come back on their own before we email them. The whole feature is
   * this number: somebody reading the thread in a browser does not need a notification about a reply
   * they are already looking at.
   */
  delaySeconds: 1800,
  /** Rows taken per sweep. At one sweep every five minutes that is 600/hour, far over any real load. */
  batchSize: 50,
  /**
   * How long a row may sit in `sending` before the next sweep puts it back. Without this, an isolate
   * that dies mid-send silences that recipient on that ticket permanently.
   */
  reapAfterSeconds: 600,
  /** Attempts before a notification is abandoned. Backoff is `60 * 2^attempts` seconds. */
  maxAttempts: 5,
  /** Agent replies quoted in one digest email, newest first. */
  maxDigestMessages: 10,
  /** Characters of each quoted reply. */
  excerptLength: 300,
} as const

/** Limits on what Email Routing hands us. */
const INBOUND = {
  /** Bytes. Checked before `message.raw` is touched — the point is not to buffer a huge message. */
  maxBytes: 1_048_576,
  /** Messages accepted from one address per hour before it is refused at SMTP level. */
  hourlyLimitPerSender: 20,
  /** Characters of the body handed to the extraction model. A forwarded thread is not worth more. */
  aiInputChars: 6000,
} as const

/** Abuse controls on the unauthenticated ticket form. */
const TICKET_CREATION = {
  /** Tickets accepted per client IP per hour. */
  hourlyLimitPerIp: 5,
  /** Tickets accepted per requester address per hour. */
  hourlyLimitPerEmail: 3,
  /** Shortest body that counts as a support request. */
  minBodyLength: 10,
} as const

/** The help centre's search and assistant. */
const HELP_SEARCH = {
  defaultLimit: 10,
  maxLimit: 50,
  /** Terms taken from a query before the rest is discarded. */
  maxTokens: 8,
  maxTokenLength: 48,
  /** At or below this many results, the query is logged so somebody can write the missing article. */
  logResultThreshold: 2,
} as const

const ASSIST = {
  maxQueryLength: 500,
  /** Chunks pulled from Vectorize before filtering. */
  topK: 6,
  /**
   * Cosine similarity below which a match is discarded. A first guess against bge-m3 — tune it
   * against real content rather than trusting this number.
   */
  minScore: 0.45,
  /** Characters of each chunk put in the prompt, and of the whole context. */
  maxChunkChars: 1200,
  maxContextChars: 6000,
  /** Assist calls one agent may make per hour. */
  hourlyLimitPerAgent: 60,
  /** Milliseconds before the model call is abandoned. Bounds the response, not the spend. */
  timeoutMs: 20_000,
} as const

/** Article chunking for the vector index. */
const EMBEDDING = {
  /** Dimensions of `@cf/baai/bge-m3`. The Vectorize index must be created with exactly this. */
  dimensions: 1024,
  maxChunkChars: 1200,
} as const

/** `public, max-age=` value on published help content, the only responses a shared cache may keep. */
const PUBLIC_CACHE_SECONDS = 60

/** Prefix on the human-readable ticket reference, e.g. `FS-1042`. */
const TICKET_REFERENCE_PREFIX = 'FS'

export {
  ADMIN_PERMISSION,
  AGENT_PERMISSION,
  ASSIST,
  AUTHOR_TYPE,
  BODY_LIMITS,
  CONTENT_STATUS,
  EMBEDDING,
  HELP_SEARCH,
  INBOUND,
  JWKS_CACHE_TTL,
  MESSAGE_KIND,
  NOTIFICATIONS,
  PAGINATION,
  PARTICIPANT_ROLE,
  PUBLIC_CACHE_SECONDS,
  REQUESTER_VISIBLE_STATUS,
  TICKET_CREATION,
  TICKET_EVENTS,
  TICKET_PRIORITY,
  TICKET_REFERENCE_PREFIX,
  TICKET_SOURCE,
  TICKET_STATUS,
}
export type {
  AuthorType,
  ContentStatus,
  MessageKind,
  ParticipantRole,
  TicketEvent,
  TicketPriority,
  TicketSource,
  TicketStatus,
}
