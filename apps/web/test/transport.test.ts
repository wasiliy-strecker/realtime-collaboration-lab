// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createBoardSnapshot,
  protocolVersion,
  type BoardEvent,
  type BoardSnapshot,
  type ParticipantPresence,
} from '@realtime-collaboration/protocol'
import type { SyncTransportSink } from '@realtime-collaboration/sync-engine'

import { BoardWebSocketTransport, collaborationWebSocketUrl } from '../src/transport.js'
import { asWebSocket, FakeBrowserSocket } from './helpers.js'

const ids = {
  actor: '00000000-0000-4000-8000-000000000201',
  board: '00000000-0000-4000-8000-000000000100',
  card: '00000000-0000-4000-8000-000000000202',
  client: '00000000-0000-4000-8000-000000000203',
  operation: '00000000-0000-4000-8000-000000000204',
} as const

function createSink() {
  const calls = {
    snapshot:
      vi.fn<SyncTransportSink<BoardSnapshot, BoardEvent, ParticipantPresence>['receiveSnapshot']>(),
    operations:
      vi.fn<
        SyncTransportSink<BoardSnapshot, BoardEvent, ParticipantPresence>['receiveOperations']
      >(),
    acknowledgement:
      vi.fn<
        SyncTransportSink<BoardSnapshot, BoardEvent, ParticipantPresence>['receiveAcknowledgement']
      >(),
    rejection:
      vi.fn<
        SyncTransportSink<BoardSnapshot, BoardEvent, ParticipantPresence>['receiveRejection']
      >(),
    presence:
      vi.fn<SyncTransportSink<BoardSnapshot, BoardEvent, ParticipantPresence>['receivePresence']>(),
    closed:
      vi.fn<
        SyncTransportSink<BoardSnapshot, BoardEvent, ParticipantPresence>['connectionClosed']
      >(),
  }
  const sink: SyncTransportSink<BoardSnapshot, BoardEvent, ParticipantPresence> = {
    receiveSnapshot: calls.snapshot,
    receiveOperations: calls.operations,
    receiveAcknowledgement: calls.acknowledgement,
    receiveRejection: calls.rejection,
    receivePresence: calls.presence,
    connectionClosed: calls.closed,
  }
  return { calls, sink }
}

function createTransport(onUnexpectedClose = vi.fn()) {
  const socket = new FakeBrowserSocket('ws://localhost/ws')
  const transport = new BoardWebSocketTransport({
    boardId: ids.board,
    clientId: ids.client,
    url: socket.url,
    createSocket: () => asWebSocket(socket),
    onUnexpectedClose,
  })
  return { onUnexpectedClose, socket, transport }
}

beforeEach(() => FakeBrowserSocket.reset())

describe('BoardWebSocketTransport', () => {
  it('opens with resume state and sends typed command, replay, and presence messages', async () => {
    const { sink } = createSink()
    const { socket, transport } = createTransport()
    const opening = transport.open({ resumeFrom: 7, sink })
    expect(transport.sendPresence({ selectedCardId: null, editingCardId: null })).toBe(false)

    socket.open()
    await opening
    expect(socket.jsonMessages()[0]).toEqual({
      type: 'hello',
      protocolVersion,
      boardId: ids.board,
      clientId: ids.client,
      lastSeenSeq: 7,
    })

    await transport.send({
      operationId: ids.operation,
      baseSeq: 7,
      command: {
        type: 'card.create',
        cardId: ids.card,
        title: 'Release notes',
        laneId: 'planned',
        beforeCardId: null,
      },
    })
    await transport.requestReplay(7)
    expect(transport.sendPresence({ selectedCardId: ids.card, editingCardId: null })).toBe(true)

    expect(socket.jsonMessages().map((message) => message.type)).toEqual([
      'hello',
      'command',
      'replay-request',
      'presence',
    ])
  })

  it('routes every server message into the generic sync sink', async () => {
    const { calls, sink } = createSink()
    const { socket, transport } = createTransport()
    const opening = transport.open({ resumeFrom: 0, sink })
    socket.open()
    await opening
    const board = createBoardSnapshot({ boardId: ids.board, title: 'August release' })
    const participant = {
      actorId: ids.actor,
      displayName: 'Ada',
      selectedCardId: null,
      editingCardId: null,
      observedAt: '2026-08-09T09:00:00.000+02:00',
    }
    const operation = {
      operationId: ids.operation,
      serverSeq: 1,
      actorId: ids.actor,
      appliedAt: '2026-08-09T09:00:01.000+02:00',
      event: {
        type: 'card.created' as const,
        card: {
          id: ids.card,
          title: 'Release notes',
          laneId: 'planned' as const,
          assigneeId: null,
          ready: false,
        },
        beforeCardId: null,
      },
    }

    socket.message({ type: 'snapshot', protocolVersion, board, participants: [participant] })
    socket.message({
      type: 'replay',
      protocolVersion,
      fromSeq: 0,
      toSeq: 1,
      operations: [operation],
      caughtUp: true,
    })
    socket.message({ type: 'operation', protocolVersion, operation })
    socket.message({
      type: 'ack',
      protocolVersion,
      operationId: ids.operation,
      serverSeq: 1,
    })
    socket.message({
      type: 'reject',
      protocolVersion,
      operationId: ids.operation,
      code: 'invalid_command',
      message: 'Rejected',
    })
    socket.message({ type: 'presence', protocolVersion, participants: [participant] })
    socket.message({ type: 'ping', protocolVersion, nonce: 'heartbeat-1' })

    expect(calls.snapshot).toHaveBeenCalledWith(board, 0, [participant])
    expect(calls.operations).toHaveBeenCalledTimes(2)
    expect(calls.acknowledgement).toHaveBeenCalledWith(ids.operation, 1)
    expect(calls.rejection).toHaveBeenCalledWith({
      operationId: ids.operation,
      code: 'invalid_command',
      message: 'Rejected',
    })
    expect(calls.presence).toHaveBeenCalledWith([participant])
    expect(socket.jsonMessages().at(-1)).toEqual({
      type: 'pong',
      protocolVersion,
      nonce: 'heartbeat-1',
    })
  })

  it('closes invalid frames and reports only unexpected disconnects', async () => {
    const { calls, sink } = createSink()
    const { onUnexpectedClose, socket, transport } = createTransport()
    const opening = transport.open({ resumeFrom: 0, sink })
    socket.open()
    await opening

    socket.binaryMessage(new ArrayBuffer(2))
    expect(socket.closes[0]).toMatchObject({ code: 1008 })
    expect(calls.closed).toHaveBeenCalledOnce()
    expect(onUnexpectedClose).toHaveBeenCalledOnce()

    const second = createTransport()
    const secondOpening = second.transport.open({ resumeFrom: 0, sink: createSink().sink })
    second.socket.open()
    await secondOpening
    await second.transport.close()
    expect(second.onUnexpectedClose).not.toHaveBeenCalled()
  })

  it('rejects failed handshakes and derives secure same-origin URLs', async () => {
    const { socket, transport } = createTransport()
    const opening = transport.open({ resumeFrom: 0, sink: createSink().sink })
    socket.error()
    await expect(opening).rejects.toThrow('connection failed')
    expect(socket.closes).toHaveLength(1)

    expect(collaborationWebSocketUrl({ protocol: 'https:', host: 'example.dev' })).toBe(
      'wss://example.dev/ws',
    )
    expect(collaborationWebSocketUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/ws',
    )
  })
})
