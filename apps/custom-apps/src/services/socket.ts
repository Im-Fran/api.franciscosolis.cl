import { DurableObject } from 'cloudflare:workers'
import { and, eq, isNotNull } from 'drizzle-orm'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { installations } from '@/db/schema'
import type { Env } from '@/env'
import { TELEMETRY } from '@/lib/config'
import { acknowledgeCommand, commandAckSchema } from '@/services/commands'
import { directivesFor, heartbeatBodySchema, loadDevice, recordHeartbeat } from '@/services/heartbeat'

/**
 * Socket presence: one Durable Object per installation, named by its id.
 *
 * The device opens `GET /socket` (authenticated by the ingest route, which then hands the request
 * here) and keeps it open. It sends its heartbeats down the socket instead of over HTTP and gets the
 * same answer back; the panel, meanwhile, can reach it at once — a new command, a state change, new
 * config or messages are pushed as a `sync` the moment they are saved, instead of waiting for the next
 * heartbeat.
 *
 * The socket is held with the Hibernation API, so an idle kiosk costs nothing between messages: the
 * object is evicted from memory while the connection stays open, and wakes for the next message. That
 * is why everything it needs to remember lives in the socket's attachment rather than in fields, and
 * why the protocol's keep-alive (`{"type":"ping"}`) is answered by the runtime without waking it.
 *
 * Protocol, JSON text frames both ways:
 *
 * - server → device on connect: `{ type: 'hello', data: <directives> }`
 * - device → server: `{ type: 'heartbeat', ...heartbeat body }` → `{ type: 'heartbeat_ack', data }`
 * - device → server: `{ type: 'command_ack', id, status, result }` → `{ type: 'command_ack', data }`
 * - server → device whenever the panel changes something: `{ type: 'sync', data: <directives> }`
 * - device → server: `{ type: 'ping' }` → `{ type: 'pong' }`, answered without waking the object
 * - server → device on a bad frame: `{ type: 'error', error }`
 *
 * One socket per installation: a new connection closes the previous one (4000), and a revoked
 * installation is disconnected (4001).
 */

/** Headers the ingest route hands the authenticated device over in. Never read from the network. */
const SOCKET_HEADERS = {
  installation: 'X-Custom-Apps-Installation',
  app: 'X-Custom-Apps-App',
  ip: 'X-Custom-Apps-Ip',
} as const

const CLOSE = {
  replaced: 4000,
  revoked: 4001,
} as const

type Attachment = { installationId: string; appId: string; ip: string | null }

const incomingSchema = v.variant('type', [
  v.object({ type: v.literal('heartbeat'), ...heartbeatBodySchema.entries }),
  v.object({ type: v.literal('command_ack'), id: v.pipe(v.string(), v.uuid()), ...commandAckSchema.entries }),
])

const send = (socket: WebSocket, message: unknown) => {
  try {
    socket.send(JSON.stringify(message))
  } catch {
    // The socket closed between the check and the send; the next sync or reconnect catches up.
  }
}

/** Stamps the installation's socket columns. A close only counts when no other socket is left. */
const markSocket = (env: Env, installationId: string, open: boolean, now: Date = new Date()) => {
  const seconds = Math.floor(now.getTime() / 1000)
  return env.DB.prepare(
    open
      ? 'UPDATE installations SET socket_connected_at = ? WHERE id = ?'
      : 'UPDATE installations SET socket_connected_at = NULL, socket_closed_at = ? WHERE id = ?',
  )
    .bind(seconds, installationId)
    .run()
}

class InstallationSocket extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'))
  }

  /** Open sockets, the one being closed excepted. */
  private open(except?: WebSocket) {
    return this.ctx.getWebSockets().filter((socket) => socket !== except && socket.readyState === WebSocket.OPEN)
  }

  async fetch(request: Request): Promise<Response> {
    const installationId = request.headers.get(SOCKET_HEADERS.installation)
    const appId = request.headers.get(SOCKET_HEADERS.app)
    if (!installationId || !appId) {
      return new Response('Not Found', { status: 404 })
    }

    for (const socket of this.open()) {
      socket.close(CLOSE.replaced, 'Replaced by a newer connection')
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ installationId, appId, ip: request.headers.get(SOCKET_HEADERS.ip) } satisfies Attachment)

    await markSocket(this.env, installationId, true)
    const loaded = await loadDevice(this.env, installationId, appId)
    if (loaded) {
      send(server, { type: 'hello', data: await directivesFor(this.env, loaded.appRow, loaded.installation) })
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer) {
    const attachment = socket.deserializeAttachment() as Attachment | null
    if (!attachment) {
      socket.close(1011, 'Lost track of this connection; reconnect')
      return
    }
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
    if (text.length > TELEMETRY.maxBodyBytes) {
      send(socket, { type: 'error', error: `Messages are limited to ${TELEMETRY.maxBodyBytes} bytes` })
      return
    }
    let parsed: v.SafeParseResult<typeof incomingSchema>
    try {
      parsed = v.safeParse(incomingSchema, JSON.parse(text))
    } catch {
      send(socket, { type: 'error', error: 'Messages are JSON' })
      return
    }
    if (!parsed.success) {
      send(socket, { type: 'error', error: parsed.issues[0]?.message ?? 'Unknown message' })
      return
    }

    const { success } = await this.env.INGEST_LIMITER.limit({ key: attachment.installationId })
    if (!success) {
      send(socket, { type: 'error', error: 'Too many messages from this installation' })
      return
    }

    const message = parsed.output
    if (message.type === 'heartbeat') {
      const { type: _type, ...body } = message
      const directives = await recordHeartbeat(this.env, { installationId: attachment.installationId, appId: attachment.appId, body, ip: attachment.ip })
      if (!directives) {
        socket.close(CLOSE.revoked, 'The installation was revoked')
        return
      }
      send(socket, { type: 'heartbeat_ack', data: directives })
      return
    }

    const result = await acknowledgeCommand(getDb(this.env), attachment.installationId, message.id, { status: message.status, result: message.result })
    send(socket, result.outcome === 'not_found' ? { type: 'error', error: 'Command not found' } : { type: 'command_ack', data: { id: message.id, outcome: result.outcome } })
  }

  async webSocketClose(socket: WebSocket, code: number) {
    await this.closed(socket)
    try {
      socket.close(code === 1005 ? 1000 : code, 'Closed')
    } catch {
      // Already closed on both sides.
    }
  }

  async webSocketError(socket: WebSocket) {
    await this.closed(socket)
  }

  private async closed(socket: WebSocket) {
    const attachment = socket.deserializeAttachment() as Attachment | null
    if (attachment && this.open(socket).length === 0) {
      await markSocket(this.env, attachment.installationId, false)
    }
  }

  /** Pushes the device's current directives down its socket. False when no socket is open. */
  async sync(): Promise<boolean> {
    const [socket] = this.open()
    const attachment = socket?.deserializeAttachment() as Attachment | null | undefined
    if (!socket || !attachment) return false
    const loaded = await loadDevice(this.env, attachment.installationId, attachment.appId)
    if (!loaded || loaded.installation.status !== 'active') {
      socket.close(CLOSE.revoked, 'The installation was revoked')
      return false
    }
    send(socket, { type: 'sync', data: await directivesFor(this.env, loaded.appRow, loaded.installation) })
    return true
  }

  /** Closes every socket of the installation, for a revocation. */
  async disconnect(): Promise<void> {
    for (const socket of this.open()) {
      socket.close(CLOSE.revoked, 'The installation was revoked')
    }
  }
}

const stubFor = (env: Env, installationId: string) => env.PRESENCE.get(env.PRESENCE.idFromName(installationId))

/**
 * Tells one installation about a change now, when it holds a socket. Never throws: the change is
 * already saved, and a device that misses the push gets it on its next heartbeat anyway.
 */
const syncInstallation = async (env: Env, installationId: string) => {
  try {
    return await stubFor(env, installationId).sync()
  } catch (error) {
    console.error('failed to sync an installation', installationId, error)
    return false
  }
}

/** Most sockets one change is pushed to. Beyond that, the next heartbeat is soon enough. */
const MAX_SYNC_FANOUT = 500

/** Tells every installation of an app holding a socket about a change. Answers how many were told. */
const syncApp = async (env: Env, appId: string) => {
  const rows = await getDb(env)
    .select({ id: installations.id })
    .from(installations)
    .where(and(eq(installations.appId, appId), eq(installations.status, 'active'), isNotNull(installations.socketConnectedAt)))
    .limit(MAX_SYNC_FANOUT)
  const results = await Promise.all(rows.map((row) => syncInstallation(env, row.id)))
  return results.filter(Boolean).length
}

/** Closes a revoked installation's socket, if it holds one. Never throws. */
const disconnectInstallation = async (env: Env, installationId: string) => {
  try {
    await stubFor(env, installationId).disconnect()
  } catch (error) {
    console.error('failed to disconnect an installation', installationId, error)
  }
}

export { CLOSE, disconnectInstallation, InstallationSocket, SOCKET_HEADERS, syncApp, syncInstallation }
