import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { protocolVersion } from '@realtime-collaboration/protocol'

import { buildGateway } from '../src/app.js'
import { ids, FakeNotifier, MemoryCollaborationStore } from './helpers.js'

const apps: Awaited<ReturnType<typeof buildGateway>>[] = []
const secret = 'a-secure-session-secret-with-at-least-32-bytes'

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('Fastify gateway', () => {
  it('exposes health and creates a secure demo session', async () => {
    const notifier = new FakeNotifier()
    const app = await createApp(notifier)

    const health = await app.inject({ method: 'GET', url: '/api/health' })
    const ready = await app.inject({ method: 'GET', url: '/api/ready' })
    notifier.handlers?.listenerError?.(new Error('listener unavailable'))
    const metrics = await app.inject({ method: 'GET', url: '/metrics' })
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/demo-sessions',
      payload: { displayName: '' },
    })
    const session = await app.inject({
      method: 'POST',
      url: '/api/demo-sessions',
      payload: { displayName: 'Ada' },
    })
    const cookie = session.headers['set-cookie']
    const restored = await app.inject({
      method: 'GET',
      url: '/api/demo-session',
      headers: { cookie },
    })
    const anonymous = await app.inject({ method: 'GET', url: '/api/demo-session' })

    expect(health.json()).toEqual({ status: 'ok' })
    expect(ready.json()).toEqual({ status: 'ready' })
    expect(metrics.headers['content-type']).toContain('text/plain')
    expect(metrics.body).toContain('realtime_collaboration_active_connections 0')
    expect(metrics.body).toContain('realtime_collaboration_notification_errors_total 1')
    expect(invalid).toMatchObject({ statusCode: 400 })
    expect(invalid.headers['content-type']).toContain('application/problem+json')
    expect(session).toMatchObject({ statusCode: 200 })
    expect(session.json()).toMatchObject({
      displayName: 'Ada',
      boardId: ids.board,
    })
    expect(session.cookies[0]).toMatchObject({
      name: 'collaboration_session',
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
    })
    expect(restored.json()).toEqual(session.json())
    expect(anonymous.statusCode).toBe(401)

    await app.close()
    expect(notifier.stopCalls).toBe(1)
    apps.splice(apps.indexOf(app), 1)
  })

  it('reports database readiness failure without exposing its cause', async () => {
    const app = await createApp(new FakeNotifier(), new MemoryCollaborationStore(), () =>
      Promise.reject(new Error('private database hostname')),
    )

    const response = await app.inject({ method: 'GET', url: '/api/ready' })

    expect(response.statusCode).toBe(503)
    expect(response.headers['content-type']).toContain('application/problem+json')
    expect(response.json()).toMatchObject({ code: 'not_ready', status: 503 })
    expect(response.body).not.toContain('private database hostname')
  })

  it('protects board snapshots and bounded operation replay', async () => {
    const store = new MemoryCollaborationStore()
    const app = await createApp(new FakeNotifier(), store)
    const unauthorized = await app.inject({ method: 'GET', url: `/api/boards/${ids.board}` })
    const cookie = await createSessionCookie(app)
    const board = await app.inject({
      method: 'GET',
      url: `/api/boards/${ids.board}`,
      headers: { cookie },
    })
    const invalidBoard = await app.inject({
      method: 'GET',
      url: '/api/boards/not-a-uuid',
      headers: { cookie },
    })
    const missingBoard = await app.inject({
      method: 'GET',
      url: '/api/boards/00000000-0000-4000-8000-000000000999',
      headers: { cookie },
    })
    const replay = await app.inject({
      method: 'GET',
      url: `/api/boards/${ids.board}/operations?after=0&limit=10`,
      headers: { cookie },
    })
    const invalidReplay = await app.inject({
      method: 'GET',
      url: `/api/boards/${ids.board}/operations?after=-1`,
      headers: { cookie },
    })

    expect(unauthorized.statusCode).toBe(401)
    expect(board.json()).toMatchObject({ boardId: ids.board, sequence: 0 })
    expect(invalidBoard.statusCode).toBe(400)
    expect(missingBoard.statusCode).toBe(404)
    expect(replay.json()).toEqual({ operations: [] })
    expect(invalidReplay.statusCode).toBe(400)
  })

  it('runs the typed hello, command, acknowledgement, and replay flow over WebSocket', async () => {
    const store = new MemoryCollaborationStore()
    const app = await createApp(new FakeNotifier(), store)
    await app.listen({ host: '127.0.0.1', port: 0 })
    const cookie = await createSessionCookie(app)
    const address = app.server.address() as AddressInfo
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      headers: { Cookie: cookie, Origin: 'http://localhost:5173' },
    })
    await opened(socket)
    const messages = collectMessages(socket)

    socket.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion,
        boardId: ids.board,
        clientId: ids.client,
        lastSeenSeq: null,
      }),
    )
    await expectMessage(messages, 'snapshot')
    socket.send(
      JSON.stringify({
        type: 'command',
        protocolVersion,
        boardId: ids.board,
        operationId: ids.operation,
        baseSeq: 0,
        command: {
          type: 'card.create',
          cardId: ids.card,
          title: 'Release notes',
          laneId: 'planned',
          beforeCardId: null,
        },
      }),
    )

    await expectMessage(messages, 'ack')
    const replay = await expectMessage(messages, 'replay', (message) => message.toSeq === 1)
    expect(replay).toMatchObject({ fromSeq: 0, caughtUp: true })
    expect(store.operations).toHaveLength(1)

    socket.close()
  })

  it('rejects WebSocket handshakes from untrusted origins or without a session', async () => {
    const app = await createApp(new FakeNotifier())
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address() as AddressInfo
    const cookie = await createSessionCookie(app)

    await expect(
      rejectedUpgrade(`ws://127.0.0.1:${address.port}/ws`, {
        Cookie: cookie,
        Origin: 'https://attacker.example',
      }),
    ).resolves.toBe(403)
    await expect(
      rejectedUpgrade(`ws://127.0.0.1:${address.port}/ws`, {
        Origin: 'http://localhost:5173',
      }),
    ).resolves.toBe(401)
  })
})

async function createApp(
  notifier: FakeNotifier,
  store = new MemoryCollaborationStore(),
  readinessCheck: () => Promise<void> = () => Promise.resolve(),
): Promise<Awaited<ReturnType<typeof buildGateway>>> {
  const app = await buildGateway({
    store,
    notifier,
    sessionSecret: secret,
    allowedOrigins: new Set(['http://localhost:5173']),
    readinessCheck,
    heartbeatIntervalMs: 60_000,
    logger: false,
  })
  apps.push(app)
  return app
}

async function createSessionCookie(app: Awaited<ReturnType<typeof buildGateway>>): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/demo-sessions',
    payload: { displayName: 'Ada' },
  })
  const header = response.headers['set-cookie']

  if (!header) {
    throw new Error('Session cookie was not returned')
  }

  const cookieHeader = Array.isArray(header) ? header[0] : header
  return cookieHeader!.split(';', 1)[0]!
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
}

function collectMessages(socket: WebSocket): unknown[] {
  const messages: unknown[] = []
  socket.on('message', (data) => {
    const buffer = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data)
    messages.push(JSON.parse(buffer.toString('utf8')) as unknown)
  })
  return messages
}

async function expectMessage(
  messages: unknown[],
  type: string,
  predicate: (message: Record<string, unknown>) => boolean = () => true,
): Promise<Record<string, unknown>> {
  let found: Record<string, unknown> | undefined
  await expect
    .poll(() => {
      found = messages.find((message): message is Record<string, unknown> => {
        if (typeof message !== 'object' || message === null) {
          return false
        }

        const candidate = message as Record<string, unknown>
        return candidate.type === type && predicate(candidate)
      })
      return found
    })
    .toBeDefined()
  return found!
}

function rejectedUpgrade(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers })
    socket.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0)
      response.resume()
    })
    socket.once('open', () => {
      socket.close()
      reject(new Error('WebSocket upgrade unexpectedly succeeded'))
    })
    socket.once('error', () => undefined)
  })
}
