import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { RawData } from 'ws'

import { boardIdSchema } from '@realtime-collaboration/protocol'

import { ConnectionController } from './connection-controller.js'
import { demoBoardId, type CollaborationStore } from './collaboration.js'
import { createPrometheusGatewayObservability, type GatewayObservability } from './observability.js'
import type { CollaborationNotifier } from './postgres/notifier.js'
import { RoomHub } from './room-hub.js'
import {
  createSessionSigner,
  sessionCookieName,
  type SessionIdentity,
  type SessionSigner,
} from './session.js'

const sessionRequestSchema = z.object({ displayName: z.string().trim().min(1).max(80) }).strict()
const boardParamsSchema = z.object({ boardId: boardIdSchema }).strict()
const operationsQuerySchema = z
  .object({
    after: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(500).default(500),
  })
  .strict()

export interface BuildGatewayOptions {
  readonly store: CollaborationStore
  readonly notifier: CollaborationNotifier
  readonly sessionSecret: string
  readonly allowedOrigins: ReadonlySet<string>
  readonly readinessCheck: () => Promise<void>
  readonly secureCookies?: boolean
  readonly logger?: boolean | { readonly level: string }
  readonly heartbeatIntervalMs?: number
  readonly heartbeatTimeoutMs?: number
  readonly maxBufferedBytes?: number
  readonly now?: () => number
  readonly sessionSigner?: SessionSigner
  readonly observability?: GatewayObservability
}

export async function buildGateway(options: BuildGatewayOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false })
  const observability = options.observability ?? createPrometheusGatewayObservability(app.log)
  const signer =
    options.sessionSigner ??
    createSessionSigner({
      secret: options.sessionSecret,
      ...(options.now ? { now: options.now } : {}),
    })
  const hub = new RoomHub(options.store, options.notifier, {
    ...(options.now ? { now: options.now } : {}),
    ...(options.heartbeatTimeoutMs ? { heartbeatTimeoutMs: options.heartbeatTimeoutMs } : {}),
    ...(options.maxBufferedBytes ? { maxBufferedBytes: options.maxBufferedBytes } : {}),
    observability,
  })
  const controller = new ConnectionController(
    options.store,
    hub,
    options.now ?? Date.now,
    observability,
  )

  await app.register(cookie)
  await app.register(websocket, { options: { maxPayload: 16 * 1_024 } })
  await options.notifier.start({
    operationCommitted: (boardId) => hub.scheduleBoardPump(boardId),
    presenceChanged: (notification) => hub.applyPresence(notification),
    listenerError: (error) => observability.observe({ type: 'notification.failed', error }),
  })

  const heartbeat = setInterval(() => hub.heartbeat(), options.heartbeatIntervalMs ?? 15_000)
  heartbeat.unref()

  app.addHook('onClose', async () => {
    clearInterval(heartbeat)
    await options.notifier.stop()
  })

  app.get('/api/health', () => ({ status: 'ok' }))

  app.get('/api/ready', async (_request, reply) => {
    try {
      await options.readinessCheck()
      return { status: 'ready' }
    } catch (error) {
      app.log.warn({ event: 'readiness.failed', error }, 'Gateway readiness check failed')
      return problem(reply, 503, 'not_ready', 'Gateway is not ready')
    }
  })

  app.get('/metrics', async (_request, reply) =>
    reply.type(observability.contentType).send(await observability.metrics()),
  )

  app.post('/api/demo-sessions', async (request, reply) => {
    const body = sessionRequestSchema.safeParse(request.body)

    if (!body.success) {
      return problem(reply, 400, 'invalid_session', 'Display name is invalid')
    }

    const session = signer.create(body.data.displayName)
    reply.setCookie(sessionCookieName, session.token, {
      httpOnly: true,
      maxAge: 24 * 60 * 60,
      path: '/',
      sameSite: 'strict',
      secure: options.secureCookies ?? false,
    })
    return sessionPayload(session.identity)
  })

  app.get('/api/demo-session', (request, reply) => {
    const identity = authenticateHttp(request, reply, signer)
    return identity ? sessionPayload(identity) : reply
  })

  app.get('/api/boards/:boardId', async (request, reply) => {
    if (!authenticateHttp(request, reply, signer)) {
      return reply
    }

    const params = boardParamsSchema.safeParse(request.params)

    if (!params.success) {
      return problem(reply, 400, 'invalid_board_id', 'Board identifier is invalid')
    }

    const board = await options.store.getBoard(params.data.boardId)
    return board ?? problem(reply, 404, 'board_not_found', 'Board does not exist')
  })

  app.get('/api/boards/:boardId/operations', async (request, reply) => {
    if (!authenticateHttp(request, reply, signer)) {
      return reply
    }

    const params = boardParamsSchema.safeParse(request.params)
    const query = operationsQuerySchema.safeParse(request.query)

    if (!params.success || !query.success) {
      return problem(reply, 400, 'invalid_replay_request', 'Replay request is invalid')
    }

    const operations = await options.store.listOperations(
      params.data.boardId,
      query.data.after,
      query.data.limit,
    )
    return { operations }
  })

  app.get(
    '/ws',
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const origin = request.headers.origin

        if (!origin || !isAllowedOrigin(origin, options.allowedOrigins)) {
          await problem(reply, 403, 'origin_forbidden', 'WebSocket origin is not allowed')
          return
        }

        if (!readIdentity(request, signer)) {
          await problem(reply, 401, 'session_required', 'A valid demo session is required')
        }
      },
    },
    (socket, request) => {
      const identity = readIdentity(request, signer)

      if (!identity) {
        socket.close(1008, 'A valid demo session is required')
        return
      }

      const connection = hub.createConnection(socket, identity)
      let processing = Promise.resolve()

      socket.on('message', (data, isBinary) => {
        const payload = toBuffer(data)
        processing = processing
          .then(() => controller.handle(connection, payload, isBinary))
          .catch((error: unknown) => {
            app.log.warn({ error }, 'Closing invalid collaboration connection')
            hub.close(connection, 1008, 'Invalid collaboration message', 'protocol_violation')
          })
      })
      socket.on('close', () => {
        void hub
          .leave(connection)
          .catch((error: unknown) => app.log.warn({ error }, 'Presence cleanup failed'))
      })
    },
  )

  return app
}

function authenticateHttp(
  request: FastifyRequest,
  reply: FastifyReply,
  signer: SessionSigner,
): SessionIdentity | null {
  const identity = readIdentity(request, signer)

  if (!identity) {
    void problem(reply, 401, 'session_required', 'A valid demo session is required')
  }

  return identity
}

function readIdentity(request: FastifyRequest, signer: SessionSigner): SessionIdentity | null {
  const token = request.cookies[sessionCookieName]
  return token ? signer.verify(token) : null
}

function isAllowedOrigin(origin: string, allowedOrigins: ReadonlySet<string>): boolean {
  try {
    return allowedOrigins.has(new URL(origin).origin)
  } catch {
    return false
  }
}

function sessionPayload(identity: SessionIdentity): {
  readonly actorId: string
  readonly displayName: string
  readonly boardId: string
} {
  return {
    actorId: identity.actorId,
    displayName: identity.displayName,
    boardId: demoBoardId,
  }
}

function problem(reply: FastifyReply, status: number, code: string, detail: string): FastifyReply {
  return reply
    .code(status)
    .type('application/problem+json')
    .send({
      type: `https://realtime-collaboration.dev/problems/${code}`,
      title: detail,
      status,
      detail,
      code,
    })
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data)
  }

  return Buffer.from(data)
}
