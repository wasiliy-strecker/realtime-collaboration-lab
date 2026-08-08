import { describe, expect, it, vi } from 'vitest'

import { protocolVersion } from '@realtime-collaboration/protocol'

import { ConnectionController } from '../src/connection-controller.js'
import { RoomHub } from '../src/room-hub.js'
import { FakeNotifier, FakeSocket, ids, MemoryCollaborationStore } from './helpers.js'

const identity = {
  actorId: ids.actor,
  displayName: 'Ada',
  expiresAt: Date.parse('2026-08-09T08:00:00Z'),
}

describe('connection controller', () => {
  it('accepts hello, presence, replay, and pong messages in sequence', async () => {
    let now = 1_000
    const store = new MemoryCollaborationStore()
    const notifier = new FakeNotifier()
    const socket = new FakeSocket()
    const hub = new RoomHub(store, notifier, { now: () => now })
    const controller = new ConnectionController(store, hub, () => now)
    const connection = hub.createConnection(socket, identity)

    await send(controller, connection, {
      type: 'hello',
      protocolVersion,
      boardId: ids.board,
      clientId: ids.client,
      lastSeenSeq: null,
    })
    await send(controller, connection, {
      type: 'presence',
      protocolVersion,
      boardId: ids.board,
      selectedCardId: null,
      editingCardId: null,
    })
    await send(controller, connection, {
      type: 'replay-request',
      protocolVersion,
      boardId: ids.board,
      afterSeq: 0,
    })
    now = 2_000
    await send(controller, connection, { type: 'pong', protocolVersion, nonce: 'heartbeat' })

    expect(connection.phase).toBe('live')
    expect(connection.lastPongAt).toBe(2_000)
    expect(notifier.published.filter(({ action }) => action === 'upsert')).toHaveLength(2)
  })

  it('acknowledges applied and idempotently repeated commands', async () => {
    const store = new MemoryCollaborationStore()
    const socket = new FakeSocket()
    const hub = new RoomHub(store, new FakeNotifier())
    const controller = new ConnectionController(store, hub)
    const connection = hub.createConnection(socket, identity)
    await hello(controller, connection)
    const command = {
      type: 'command' as const,
      protocolVersion,
      boardId: ids.board,
      operationId: ids.operation,
      baseSeq: 0,
      command: {
        type: 'card.create' as const,
        cardId: ids.card,
        title: 'Release notes',
        laneId: 'planned' as const,
        beforeCardId: null,
      },
    }

    await send(controller, connection, command)
    await connection.pumpChain
    await send(controller, connection, command)

    expect(socket.messages.filter(isAcknowledgement)).toHaveLength(2)
    expect(store.operations).toHaveLength(1)
    expect(socket.messages).toContainEqual(
      expect.objectContaining({ type: 'replay', fromSeq: 0, toSeq: 1 }),
    )
  })

  it('returns safe rejections for invalid commands and missing boards', async () => {
    const store = new MemoryCollaborationStore()
    const socket = new FakeSocket()
    const hub = new RoomHub(store, new FakeNotifier())
    const controller = new ConnectionController(store, hub)
    const connection = hub.createConnection(socket, identity)
    await hello(controller, connection)

    await send(controller, connection, commandFor(ids.operation, ids.card))
    expect(socket.messages.at(-1)).toMatchObject({
      type: 'reject',
      code: 'target_missing',
    })

    store.board = null
    await send(controller, connection, commandFor(ids.operationTwo, ids.cardTwo))
    expect(socket.messages.at(-1)).toMatchObject({
      type: 'reject',
      code: 'target_missing',
      message: 'Board does not exist',
    })
  })

  it('closes binary, malformed JSON, invalid schema, and cross-board messages', async () => {
    const store = new MemoryCollaborationStore()
    const hub = new RoomHub(store, new FakeNotifier())
    const binarySocket = new FakeSocket()
    const controller = new ConnectionController(store, hub)
    const binary = hub.createConnection(binarySocket, identity)
    await controller.handle(binary, Buffer.from('binary'), true)
    expect(binarySocket.closes[0]).toMatchObject({ code: 1003 })

    const jsonSocket = new FakeSocket()
    const invalidJson = hub.createConnection(jsonSocket, identity)
    await controller.handle(invalidJson, Buffer.from('{'), false)
    expect(jsonSocket.closes[0]).toMatchObject({ code: 1008 })

    const invalidSchema = hub.createConnection(new FakeSocket(), identity)
    await expect(
      controller.handle(invalidSchema, Buffer.from(JSON.stringify({ type: 'unknown' })), false),
    ).rejects.toThrow()

    const crossBoardSocket = new FakeSocket()
    const crossBoard = hub.createConnection(crossBoardSocket, identity)
    await hello(controller, crossBoard)
    await send(controller, crossBoard, {
      type: 'presence',
      protocolVersion,
      boardId: '00000000-0000-4000-8000-000000000999',
      selectedCardId: null,
      editingCardId: null,
    })
    expect(crossBoardSocket.closes.at(-1)).toMatchObject({ code: 1008 })
  })

  it('rate limits commands with a rejection and other messages by closing the socket', async () => {
    const store = new MemoryCollaborationStore()
    const hub = new RoomHub(store, new FakeNotifier(), { now: () => 1_000 })
    const controller = new ConnectionController(store, hub, () => 1_000)
    const commandSocket = new FakeSocket()
    const commandConnection = hub.createConnection(commandSocket, identity)
    await hello(controller, commandConnection)

    for (let index = 0; index < 39; index += 1) {
      commandConnection.limiter.consume(1_000)
    }

    await send(controller, commandConnection, commandFor(ids.operation, ids.card))
    expect(commandSocket.messages.at(-1)).toMatchObject({ type: 'reject', code: 'rate_limited' })

    const presenceSocket = new FakeSocket()
    const presenceConnection = hub.createConnection(presenceSocket, identity)
    await hello(controller, presenceConnection, ids.client.replace(/5$/u, '6'))

    for (let index = 0; index < 39; index += 1) {
      presenceConnection.limiter.consume(1_000)
    }

    await send(controller, presenceConnection, {
      type: 'presence',
      protocolVersion,
      boardId: ids.board,
      selectedCardId: null,
      editingCardId: null,
    })
    await vi.waitFor(() => expect(presenceConnection.phase).toBe('closed'))
    expect(presenceSocket.closes.at(-1)).toMatchObject({ code: 1008 })
  })
})

async function hello(
  controller: ConnectionController,
  connection: Parameters<ConnectionController['handle']>[0],
  clientId: string = ids.client,
): Promise<void> {
  await send(controller, connection, {
    type: 'hello',
    protocolVersion,
    boardId: ids.board,
    clientId,
    lastSeenSeq: null,
  })
}

async function send(
  controller: ConnectionController,
  connection: Parameters<ConnectionController['handle']>[0],
  message: unknown,
): Promise<void> {
  await controller.handle(connection, Buffer.from(JSON.stringify(message)), false)
}

function commandFor(operationId: string, cardId: string) {
  return {
    type: 'command' as const,
    protocolVersion,
    boardId: ids.board,
    operationId,
    baseSeq: 0,
    command: { type: 'card.rename' as const, cardId, title: 'Missing card' },
  }
}

function isAcknowledgement(message: unknown): boolean {
  return (
    typeof message === 'object' && message !== null && 'type' in message && message.type === 'ack'
  )
}
