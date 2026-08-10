import { describe, expect, it, vi } from 'vitest'

import { protocolVersion } from '@realtime-collaboration/protocol'

import { RoomHub } from '../src/room-hub.js'
import {
  FakeNotifier,
  FakeSocket,
  ids,
  MemoryCollaborationStore,
  RecordingObserver,
} from './helpers.js'

const identity = {
  actorId: ids.actor,
  displayName: 'Ada',
  expiresAt: Date.parse('2026-08-09T08:00:00Z'),
}

describe('room hub', () => {
  it('sends a snapshot to a new client and publishes ephemeral presence', async () => {
    const store = new MemoryCollaborationStore()
    const notifier = new FakeNotifier()
    const socket = new FakeSocket()
    const hub = new RoomHub(store, notifier, { now: () => Date.parse('2026-08-08T08:00:00Z') })
    const connection = hub.createConnection(socket, identity)

    await expect(
      hub.join(connection, { boardId: ids.board, clientId: ids.client, lastSeenSeq: null }),
    ).resolves.toBe(true)

    expect(socket.messages[0]).toMatchObject({
      type: 'snapshot',
      protocolVersion,
      board: { boardId: ids.board, sequence: 0 },
    })
    expect(socket.messages).toContainEqual(
      expect.objectContaining({
        type: 'presence',
        participants: [expect.objectContaining({ displayName: 'Ada' })],
      }),
    )
    expect(notifier.published).toContainEqual(
      expect.objectContaining({ action: 'upsert', boardId: ids.board, clientId: ids.client }),
    )
    expect(connection.phase).toBe('live')
  })

  it('replays durable operations and pumps newly committed work in order', async () => {
    const store = new MemoryCollaborationStore()
    const observability = new RecordingObserver()
    await store.applyCommand({
      boardId: ids.board,
      actorId: ids.actor,
      operationId: ids.operation,
      baseSeq: 0,
      command: {
        type: 'card.create',
        cardId: ids.card,
        title: 'Release notes',
        laneId: 'planned',
        beforeCardId: null,
      },
    })
    const notifier = new FakeNotifier()
    const socket = new FakeSocket()
    const hub = new RoomHub(store, notifier, { observability })
    const connection = hub.createConnection(socket, identity)

    await hub.join(connection, { boardId: ids.board, clientId: ids.client, lastSeenSeq: 0 })
    expect(socket.messages[0]).toMatchObject({
      type: 'replay',
      fromSeq: 0,
      toSeq: 1,
      caughtUp: true,
    })

    await store.applyCommand({
      boardId: ids.board,
      actorId: ids.actor,
      operationId: ids.operationTwo,
      baseSeq: 1,
      command: { type: 'card.rename', cardId: ids.card, title: 'Public release notes' },
    })
    hub.scheduleBoardPump(ids.board)
    await connection.pumpChain

    expect(socket.messages).toContainEqual(
      expect.objectContaining({ type: 'replay', fromSeq: 1, toSeq: 2 }),
    )
    expect(connection.lastDeliveredSeq).toBe(2)
    expect(observability.events).toContainEqual(
      expect.objectContaining({
        type: 'replay.completed',
        trigger: 'join',
        batches: 1,
        operations: 1,
      }),
    )
    expect(observability.events).toContainEqual(
      expect.objectContaining({
        type: 'replay.completed',
        trigger: 'live_pump',
        batches: 1,
        operations: 1,
      }),
    )
  })

  it('returns an empty caught-up replay and supports an explicit replay request', async () => {
    const store = new MemoryCollaborationStore()
    const socket = new FakeSocket()
    const observability = new RecordingObserver()
    const hub = new RoomHub(store, new FakeNotifier(), { observability })
    const connection = hub.createConnection(socket, identity)
    await hub.join(connection, { boardId: ids.board, clientId: ids.client, lastSeenSeq: 0 })

    await hub.replay(connection, 0)

    expect(socket.messages.filter(isReplay)).toEqual([
      expect.objectContaining({ fromSeq: 0, toSeq: 0, operations: [], caughtUp: true }),
      expect.objectContaining({ fromSeq: 0, toSeq: 0, operations: [], caughtUp: true }),
    ])
    expect(observability.events).toContainEqual(
      expect.objectContaining({ type: 'replay.requested', afterSequence: 0 }),
    )
    expect(observability.events).toContainEqual(
      expect.objectContaining({
        type: 'replay.completed',
        trigger: 'explicit',
        batches: 1,
        operations: 0,
      }),
    )
  })

  it('falls back to a snapshot when the client sequence is ahead of the server', async () => {
    const socket = new FakeSocket()
    const hub = new RoomHub(new MemoryCollaborationStore(), new FakeNotifier())
    const connection = hub.createConnection(socket, identity)

    await hub.join(connection, { boardId: ids.board, clientId: ids.client, lastSeenSeq: 99 })

    expect(socket.messages[0]).toMatchObject({ type: 'snapshot', board: { sequence: 0 } })
  })

  it('closes missing boards and duplicate hello attempts', async () => {
    const store = new MemoryCollaborationStore()
    const hub = new RoomHub(store, new FakeNotifier())
    const missingSocket = new FakeSocket()
    const missing = hub.createConnection(missingSocket, identity)

    await expect(
      hub.join(missing, {
        boardId: '00000000-0000-4000-8000-000000000999',
        clientId: ids.client,
        lastSeenSeq: null,
      }),
    ).resolves.toBe(false)
    expect(missingSocket.closes[0]).toMatchObject({ code: 1008 })

    const socket = new FakeSocket()
    const connection = hub.createConnection(socket, identity)
    await hub.join(connection, { boardId: ids.board, clientId: ids.client, lastSeenSeq: null })
    await expect(
      hub.join(connection, { boardId: ids.board, clientId: ids.client, lastSeenSeq: null }),
    ).resolves.toBe(false)
    expect(socket.closes.at(-1)).toMatchObject({ code: 1008 })
  })

  it('disconnects slow consumers before growing the socket buffer', async () => {
    const notifier = new FakeNotifier()
    const socket = new FakeSocket()
    const observability = new RecordingObserver()
    socket.bufferedAmount = 1_025
    const hub = new RoomHub(new MemoryCollaborationStore(), notifier, {
      maxBufferedBytes: 1_024,
      observability,
    })
    const connection = hub.createConnection(socket, identity)

    expect(hub.send(connection, { type: 'ping', protocolVersion, nonce: 'slow-consumer' })).toBe(
      false,
    )
    await vi.waitFor(() => expect(connection.phase).toBe('closed'))
    await hub.leave(connection)
    expect(socket.closes[0]).toMatchObject({ code: 1013 })
    expect(observability.events.filter(({ type }) => type === 'connection.closed')).toEqual([
      expect.objectContaining({ cause: 'slow_consumer' }),
    ])
  })

  it('expires stale presence and closes heartbeat timeouts', async () => {
    let now = 1_000
    const socket = new FakeSocket()
    const observability = new RecordingObserver()
    const hub = new RoomHub(new MemoryCollaborationStore(), new FakeNotifier(), {
      now: () => now,
      heartbeatTimeoutMs: 2_000,
      presenceTtlMs: 1_500,
      observability,
    })
    const connection = hub.createConnection(socket, identity)
    await hub.join(connection, { boardId: ids.board, clientId: ids.client, lastSeenSeq: null })
    const messagesBeforeHeartbeat = socket.messages.length

    now = 2_600
    hub.heartbeat()
    expect(socket.messages).toHaveLength(messagesBeforeHeartbeat + 2)
    expect(socket.messages.at(-1)).toMatchObject({ type: 'presence', participants: [] })

    hub.markPong(connection)
    now = 4_601
    hub.heartbeat()
    await vi.waitFor(() => expect(connection.phase).toBe('closed'))
    expect(socket.closes.at(-1)).toMatchObject({ code: 1001 })
    expect(observability.events).toContainEqual(
      expect.objectContaining({ type: 'connection.closed', cause: 'heartbeat_timeout' }),
    )
  })

  it('applies remote presence and publishes removal exactly once', async () => {
    const notifier = new FakeNotifier()
    const socket = new FakeSocket()
    const observability = new RecordingObserver()
    const hub = new RoomHub(new MemoryCollaborationStore(), notifier, {
      now: () => 1_000,
      observability,
    })
    const connection = hub.createConnection(socket, identity)
    await hub.join(connection, { boardId: ids.board, clientId: ids.client, lastSeenSeq: null })

    hub.applyPresence({
      action: 'upsert',
      boardId: ids.board,
      clientId: '00000000-0000-4000-8000-000000000299',
      participant: {
        actorId: ids.actorTwo,
        displayName: 'Lin',
        selectedCardId: null,
        editingCardId: null,
        observedAt: '2026-08-08T08:00:00Z',
      },
    })
    expect(presenceNames(socket.messages.at(-1))).toContain('Lin')

    await hub.leave(connection)
    await hub.leave(connection)
    expect(notifier.published.filter(({ action }) => action === 'remove')).toHaveLength(1)
    expect(observability.events.filter(({ type }) => type === 'connection.closed')).toEqual([
      expect.objectContaining({ cause: 'client_closed' }),
    ])
  })

  it('does not send to sockets that are no longer open', () => {
    const socket = new FakeSocket()
    socket.readyState = 3
    const hub = new RoomHub(new MemoryCollaborationStore(), new FakeNotifier())
    const connection = hub.createConnection(socket, identity)

    expect(hub.send(connection, { type: 'ping', protocolVersion, nonce: 'closed' })).toBe(false)
  })
})

function isReplay(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'replay'
  )
}

function presenceNames(message: unknown): string[] {
  if (typeof message !== 'object' || message === null || !('participants' in message)) {
    return []
  }

  const record = message as Record<string, unknown>
  const participants = record['participants']

  if (!Array.isArray(participants)) {
    return []
  }

  const names: string[] = []

  for (const participant of participants as unknown[]) {
    if (
      typeof participant !== 'object' ||
      participant === null ||
      !('displayName' in participant)
    ) {
      continue
    }

    const candidate = participant as Record<string, unknown>

    if (typeof candidate['displayName'] === 'string') {
      names.push(candidate['displayName'])
    }
  }

  return names
}
