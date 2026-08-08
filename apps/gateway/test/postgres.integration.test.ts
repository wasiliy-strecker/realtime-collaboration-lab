import type { AddressInfo } from 'node:net'

import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { protocolVersion } from '@realtime-collaboration/protocol'

import { buildGateway } from '../src/app.js'
import { demoBoardId } from '../src/collaboration.js'
import { runMigrations, seedDemoBoard } from '../src/postgres/migrations.js'
import { PostgresCollaborationNotifier } from '../src/postgres/notifier.js'
import { PostgresCollaborationStore } from '../src/postgres/store.js'
import { ids } from './helpers.js'

const databaseUrl =
  process.env['DATABASE_URL'] ??
  'postgres://collaboration:collaboration-local-only@127.0.0.1:5432/collaboration'
const pool = new Pool({ connectionString: databaseUrl, max: 20 })

beforeAll(async () => {
  await runMigrations(pool)
})

beforeEach(async () => {
  await pool.query('TRUNCATE collaboration_operations, collaboration_boards CASCADE')
  await seedDemoBoard(pool)
})

afterAll(async () => {
  await pool.end()
})

describe('PostgreSQL collaboration store', () => {
  it('applies a command once and returns the original operation for a retry', async () => {
    const store = new PostgresCollaborationStore(pool, () => new Date('2026-08-08T08:00:00.000Z'))
    const input = createCardCommand(ids.operation, ids.card)

    const first = await store.applyCommand(input)
    const duplicate = await store.applyCommand(input)
    const board = await store.getBoard(demoBoardId)
    const operations = await store.listOperations(demoBoardId, 0)

    expect(first).toMatchObject({ kind: 'applied', operation: { serverSeq: 1 } })
    expect(duplicate).toEqual({
      kind: 'duplicate',
      operation: first.kind === 'applied' ? first.operation : undefined,
    })
    expect(board).toMatchObject({ sequence: 1, cards: [{ id: ids.card }] })
    expect(operations).toHaveLength(1)
  })

  it('serializes concurrent writers into one gap-free board sequence', async () => {
    const firstStore = new PostgresCollaborationStore(pool)
    const secondStore = new PostgresCollaborationStore(pool)

    const results = await Promise.all([
      firstStore.applyCommand(createCardCommand(ids.operation, ids.card)),
      secondStore.applyCommand(createCardCommand(ids.operationTwo, ids.cardTwo)),
    ])
    const operations = await firstStore.listOperations(demoBoardId, 0)
    const board = await firstStore.getBoard(demoBoardId)

    expect(results.map((result) => result.kind)).toEqual(['applied', 'applied'])
    expect(operations.map(({ serverSeq }) => serverSeq)).toEqual([1, 2])
    expect(board).toMatchObject({ sequence: 2 })
    expect(board?.cards.map(({ id }) => id).sort()).toEqual([ids.card, ids.cardTwo].sort())
  })

  it('rejects invalid targets without appending evidence and bounds replay queries', async () => {
    const store = new PostgresCollaborationStore(pool)
    const rejected = await store.applyCommand({
      boardId: demoBoardId,
      actorId: ids.actor,
      operationId: ids.operation,
      baseSeq: 0,
      command: { type: 'card.rename', cardId: ids.card, title: 'Missing card' },
    })
    const missing = await store.applyCommand({
      ...createCardCommand(ids.operationTwo, ids.cardTwo),
      boardId: '00000000-0000-4000-8000-000000000999',
    })

    expect(rejected).toMatchObject({ kind: 'rejected', code: 'target_missing' })
    expect(missing).toEqual({ kind: 'board-not-found' })
    expect(await store.listOperations(demoBoardId, 0, 0)).toEqual([])
    expect(await store.getBoard('00000000-0000-4000-8000-000000000999')).toBeNull()
  })
})

describe('PostgreSQL notifications', () => {
  it('relays committed sequence hints and ephemeral presence across connections', async () => {
    const listener = new PostgresCollaborationNotifier(pool)
    const publisher = new PostgresCollaborationNotifier(pool)
    let committed: { boardId: string; serverSeq: number } | null = null
    let presenceClientId: string | null = null
    await listener.start({
      operationCommitted: (boardId, serverSeq) => {
        committed = { boardId, serverSeq }
      },
      presenceChanged: (notification) => {
        presenceClientId = notification.clientId
      },
    })

    await new PostgresCollaborationStore(pool).applyCommand(
      createCardCommand(ids.operation, ids.card),
    )
    await publisher.publishPresence({
      action: 'remove',
      boardId: demoBoardId,
      clientId: ids.client,
    })

    await expect.poll(() => committed).toEqual({ boardId: demoBoardId, serverSeq: 1 })
    await expect.poll(() => presenceClientId).toBe(ids.client)

    await listener.stop()
    await listener.stop()
  })
})

describe('multi-gateway WebSocket relay', () => {
  it('delivers one committed operation to clients connected to different gateway instances', async () => {
    const first = await startGateway()
    const second = await startGateway()

    try {
      const cookie = await createSessionCookie(first.app)
      const firstSocket = openSocket(first.port, cookie)
      const secondSocket = openSocket(second.port, cookie)
      await Promise.all([opened(firstSocket), opened(secondSocket)])
      const firstMessages = collectMessages(firstSocket)
      const secondMessages = collectMessages(secondSocket)

      firstSocket.send(JSON.stringify(hello(ids.client)))
      secondSocket.send(JSON.stringify(hello('00000000-0000-4000-8000-000000000298')))
      await Promise.all([
        expectMessage(firstMessages, 'snapshot'),
        expectMessage(secondMessages, 'snapshot'),
      ])

      firstSocket.send(
        JSON.stringify({
          type: 'command',
          protocolVersion,
          boardId: demoBoardId,
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

      await expectMessage(firstMessages, 'ack')
      await Promise.all([
        expectMessage(firstMessages, 'replay', hasSequenceOne),
        expectMessage(secondMessages, 'replay', hasSequenceOne),
      ])

      expect(await new PostgresCollaborationStore(pool).getBoard(demoBoardId)).toMatchObject({
        sequence: 1,
        cards: [{ id: ids.card }],
      })

      firstSocket.close()
      secondSocket.close()
    } finally {
      await Promise.all([first.app.close(), second.app.close()])
    }
  })
})

function createCardCommand(operationId: string, cardId: string) {
  return {
    boardId: demoBoardId,
    actorId: ids.actor,
    operationId,
    baseSeq: 0,
    command: {
      type: 'card.create' as const,
      cardId,
      title: `Card ${cardId.slice(-3)}`,
      laneId: 'planned' as const,
      beforeCardId: null,
    },
  }
}

async function startGateway() {
  const app = await buildGateway({
    store: new PostgresCollaborationStore(pool),
    notifier: new PostgresCollaborationNotifier(pool),
    sessionSecret: 'a-secure-session-secret-with-at-least-32-bytes',
    allowedOrigins: new Set(['http://localhost:5173']),
    heartbeatIntervalMs: 60_000,
    logger: false,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  return { app, port: (app.server.address() as AddressInfo).port }
}

async function createSessionCookie(app: Awaited<ReturnType<typeof buildGateway>>): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/demo-sessions',
    payload: { displayName: 'Ada' },
  })
  const header = response.headers['set-cookie']
  const cookieHeader = Array.isArray(header) ? header[0] : header

  if (!cookieHeader) {
    throw new Error('Session cookie was not returned')
  }

  return cookieHeader.split(';', 1)[0]!
}

function openSocket(port: number, cookie: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { Cookie: cookie, Origin: 'http://localhost:5173' },
  })
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

function hello(clientId: string) {
  return {
    type: 'hello',
    protocolVersion,
    boardId: demoBoardId,
    clientId,
    lastSeenSeq: null,
  }
}

function hasSequenceOne(message: Record<string, unknown>): boolean {
  return message['toSeq'] === 1
}
