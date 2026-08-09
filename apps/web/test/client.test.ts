// @vitest-environment jsdom

import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { protocolVersion } from '@realtime-collaboration/protocol'

import { BoardCollaborationClient } from '../src/client.js'
import type { DemoSession } from '../src/types.js'
import { asWebSocket, FakeBrowserSocket, MemoryStorage } from './helpers.js'

const session: DemoSession = {
  actorId: '00000000-0000-4000-8000-000000000201',
  displayName: 'Ada',
  boardId: '00000000-0000-4000-8000-000000000100',
}
const cardId = '00000000-0000-4000-8000-000000000202'
const clientId = '00000000-0000-4000-8000-000000000203'

beforeEach(() => {
  vi.useFakeTimers()
  FakeBrowserSocket.reset()
})

afterEach(() => vi.useRealTimers())

describe('BoardCollaborationClient', () => {
  it('projects commands, confirms operations, throttles presence, and reconnects', async () => {
    const localStorage = new MemoryStorage()
    const sessionStorage = new MemoryStorage()
    sessionStorage.setItem('realtime-collaboration:client-id', clientId)
    const client = new BoardCollaborationClient({
      session,
      localStorage,
      sessionStorage,
      webSocketUrl: 'ws://localhost/ws',
      createSocket: (url) => asWebSocket(new FakeBrowserSocket(url)),
      random: () => 0,
    })

    client.start()
    await act(() => Promise.resolve())
    const first = FakeBrowserSocket.instances[0]!
    act(() => first.open())
    await act(() => Promise.resolve())
    expect(client.engine.getSnapshot().phase).toBe('live')

    client.dispatch({
      type: 'card.create',
      cardId,
      title: 'Release notes',
      laneId: 'planned',
      beforeCardId: null,
    })
    expect(client.engine.getSnapshot().projectedState.cards).toHaveLength(1)
    const command = first.jsonMessages().find((message) => message.type === 'command')!

    first.message({
      type: 'ack',
      protocolVersion,
      operationId: command.operationId,
      serverSeq: 1,
    })
    first.message({
      type: 'operation',
      protocolVersion,
      operation: {
        operationId: command.operationId,
        serverSeq: 1,
        actorId: session.actorId,
        appliedAt: '2026-08-09T09:00:00.000+02:00',
        event: {
          type: 'card.created',
          card: {
            id: cardId,
            title: 'Release notes',
            laneId: 'planned',
            assigneeId: null,
            ready: false,
          },
          beforeCardId: null,
        },
      },
    })
    expect(client.engine.getSnapshot()).toMatchObject({ sequence: 1, pending: [] })

    client.updatePresence({ selectedCardId: cardId, editingCardId: null })
    client.updatePresence({ selectedCardId: cardId, editingCardId: cardId })
    await act(() => vi.advanceTimersByTime(120))
    expect(
      first
        .jsonMessages()
        .filter((message) => message.type === 'presence')
        .at(-1),
    ).toMatchObject({
      selectedCardId: cardId,
      editingCardId: cardId,
    })

    act(() => first.close(1006, 'Network lost'))
    expect(client.engine.getSnapshot().phase).toBe('offline')
    await act(() => vi.advanceTimersByTime(800))
    await act(() => Promise.resolve())
    expect(FakeBrowserSocket.instances).toHaveLength(2)
    const second = FakeBrowserSocket.instances[1]!
    act(() => second.open())
    await act(() => Promise.resolve())
    expect(second.jsonMessages()[0]).toMatchObject({ type: 'hello', lastSeenSeq: 1 })

    await client.stop()
    expect(second.closes[0]).toMatchObject({ code: 1000 })
  })

  it('queues offline intent and stops without an active connection', async () => {
    const client = new BoardCollaborationClient({
      session,
      localStorage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
      webSocketUrl: 'ws://localhost/ws',
      createSocket: (url) => asWebSocket(new FakeBrowserSocket(url)),
    })

    client.dispatch({
      type: 'card.create',
      cardId,
      title: 'Queued card',
      laneId: 'planned',
      beforeCardId: null,
    })
    expect(client.engine.getSnapshot().pending[0]?.status).toBe('queued')
    await client.stop()
  })

  it('recovers when React Strict Mode starts again before asynchronous cleanup finishes', async () => {
    const client = new BoardCollaborationClient({
      session,
      localStorage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
      webSocketUrl: 'ws://localhost/ws',
      createSocket: (url) => asWebSocket(new FakeBrowserSocket(url)),
    })

    client.start()
    await act(() => Promise.resolve())
    const stopping = client.stop()
    client.start()
    await stopping
    await act(() => Promise.resolve())

    expect(FakeBrowserSocket.instances).toHaveLength(2)
    act(() => FakeBrowserSocket.instances[1]!.open())
    await act(() => Promise.resolve())
    expect(client.engine.getSnapshot().phase).toBe('live')
    await client.stop()
  })
})
