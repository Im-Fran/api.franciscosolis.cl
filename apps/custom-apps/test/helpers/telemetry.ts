import { env } from 'cloudflare:test'
import type { TelemetryMessage } from '@/services/telemetry'
import { consumeTelemetry } from '@/services/telemetry'

/**
 * The telemetry queue, replaced by assignment with one that records what was sent — the same move
 * `auth` and `marketplace` make with their notifications queue.
 */
let sent: TelemetryMessage[] = []

const captureTelemetry = () => {
  sent = []
  ;(env as { TELEMETRY_QUEUE: Queue<TelemetryMessage> }).TELEMETRY_QUEUE = {
    send: async (message: TelemetryMessage) => {
      sent.push(structuredClone(message))
    },
    sendBatch: async (messages: Iterable<MessageSendRequest<TelemetryMessage>>) => {
      for (const message of messages) sent.push(structuredClone(message.body))
    },
  } as unknown as Queue<TelemetryMessage>
  return sent
}

const sentTelemetry = () => sent

/** A batch as Cloudflare Queues would deliver it, for handing to the consumer directly. */
const batchOf = (bodies: unknown[], queue = 'franciscosolis-custom-apps-telemetry'): MessageBatch<unknown> => ({
  queue,
  messages: bodies.map((body, index) => ({
    id: `message-${index}`,
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: () => {},
    retry: () => {},
  })),
  ackAll: () => {},
  retryAll: () => {},
}) as unknown as MessageBatch<unknown>

/** Writes everything the Worker queued so far, as the consumer would, and clears the capture. */
const drainTelemetry = async () => {
  const bodies = sent.splice(0, sent.length)
  return consumeTelemetry(env, batchOf(bodies))
}

export { batchOf, captureTelemetry, drainTelemetry, sentTelemetry }
