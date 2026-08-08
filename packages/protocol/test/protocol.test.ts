import { describe, expect, it } from 'vitest'

import {
  boardSnapshotSchema,
  clientMessageSchema,
  parseClientMessage,
  parseServerMessage,
  protocolVersion,
  serverMessageSchema,
} from '../src/index.js'

const ids = {
  actor: '00000000-0000-4000-8000-000000000001',
  board: '00000000-0000-4000-8000-000000000002',
  card: '00000000-0000-4000-8000-000000000003',
  client: '00000000-0000-4000-8000-000000000004',
  operation: '00000000-0000-4000-8000-000000000005',
} as const

const operation = {
  operationId: ids.operation,
  serverSeq: 1,
  actorId: ids.actor,
  appliedAt: '2026-08-07T08:00:00+02:00',
  event: {
    type: 'card.created' as const,
    card: {
      id: ids.card,
      title: 'Prepare release notes',
      laneId: 'planned' as const,
      assigneeId: null,
      ready: false,
    },
    beforeCardId: null,
  },
}

describe('client message contracts', () => {
  it.each([
    {
      type: 'hello',
      protocolVersion,
      boardId: ids.board,
      clientId: ids.client,
      lastSeenSeq: null,
    },
    {
      type: 'command',
      protocolVersion,
      boardId: ids.board,
      operationId: ids.operation,
      baseSeq: 0,
      command: {
        type: 'card.create',
        cardId: ids.card,
        title: 'Prepare release notes',
        laneId: 'planned',
        beforeCardId: null,
      },
    },
    {
      type: 'presence',
      protocolVersion,
      boardId: ids.board,
      selectedCardId: ids.card,
      editingCardId: null,
    },
    {
      type: 'replay-request',
      protocolVersion,
      boardId: ids.board,
      afterSeq: 3,
    },
    { type: 'pong', protocolVersion, nonce: 'heartbeat-1' },
  ])('parses $type messages', (message) => {
    expect(parseClientMessage(message)).toEqual(message)
  })

  it('rejects unknown fields and protocol versions', () => {
    expect(() =>
      clientMessageSchema.parse({
        type: 'pong',
        protocolVersion: 2,
        nonce: 'heartbeat-1',
        ignored: true,
      }),
    ).toThrow()
  })
})

describe('server message contracts', () => {
  const presence = {
    actorId: ids.actor,
    displayName: 'Ada',
    selectedCardId: ids.card,
    editingCardId: null,
    observedAt: '2026-08-07T08:00:00+02:00',
  }

  it.each([
    {
      type: 'snapshot',
      protocolVersion,
      board: {
        boardId: ids.board,
        title: 'August release',
        sequence: 0,
        cards: [],
      },
      participants: [presence],
    },
    {
      type: 'replay',
      protocolVersion,
      fromSeq: 0,
      toSeq: 1,
      operations: [operation],
      caughtUp: true,
    },
    { type: 'operation', protocolVersion, operation },
    {
      type: 'ack',
      protocolVersion,
      operationId: ids.operation,
      serverSeq: 1,
    },
    {
      type: 'reject',
      protocolVersion,
      operationId: ids.operation,
      code: 'target_missing',
      message: 'The card no longer exists',
    },
    { type: 'presence', protocolVersion, participants: [presence] },
    { type: 'ping', protocolVersion, nonce: 'heartbeat-1' },
  ])('parses $type messages', (message) => {
    expect(parseServerMessage(message)).toEqual(message)
  })

  it('rejects a backwards replay range', () => {
    const result = serverMessageSchema.safeParse({
      type: 'replay',
      protocolVersion,
      fromSeq: 3,
      toSeq: 2,
      operations: [],
      caughtUp: false,
    })

    expect(result.success).toBe(false)
  })

  it('rejects replay operations with a sequence gap or mismatched end', () => {
    const gap = serverMessageSchema.safeParse({
      type: 'replay',
      protocolVersion,
      fromSeq: 1,
      toSeq: 3,
      operations: [{ ...operation, serverSeq: 3 }],
      caughtUp: true,
    })
    const mismatchedEnd = serverMessageSchema.safeParse({
      type: 'replay',
      protocolVersion,
      fromSeq: 0,
      toSeq: 2,
      operations: [operation],
      caughtUp: true,
    })

    expect(gap.success).toBe(false)
    expect(mismatchedEnd.success).toBe(false)
  })
})

describe('board snapshot contract', () => {
  it('rejects duplicate card identifiers', () => {
    const card = operation.event.card
    const result = boardSnapshotSchema.safeParse({
      boardId: ids.board,
      title: 'August release',
      sequence: 1,
      cards: [card, card],
    })

    expect(result.success).toBe(false)
  })
})
