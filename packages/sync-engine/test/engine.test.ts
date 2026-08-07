import { describe, expect, it, vi } from 'vitest'

import {
  createSyncEngine,
  type OutboundCommand,
  type PersistedSyncState,
  type SyncPersistence,
  type SyncTransport,
  type SyncTransportSink,
} from '../src/index.js'

interface CounterCommand {
  readonly amount: number
  readonly blocked?: boolean
}

class FakeTransport implements SyncTransport<number, CounterCommand, number, string> {
  public sink: SyncTransportSink<number, number, string> | null = null
  public readonly sent: OutboundCommand<CounterCommand>[] = []
  public readonly replayRequests: number[] = []
  public resumeFrom: number | null = null
  public openError: Error | null = null
  public sendError: Error | null = null
  public replayError: Error | null = null
  public closeDuringOpen = false
  public closeCalls = 0

  public open(input: {
    readonly resumeFrom: number
    readonly sink: SyncTransportSink<number, number, string>
  }): Promise<void> {
    if (this.openError) {
      return Promise.reject(this.openError)
    }

    this.resumeFrom = input.resumeFrom
    this.sink = input.sink

    if (this.closeDuringOpen) {
      input.sink.connectionClosed()
    }

    return Promise.resolve()
  }

  public send(command: OutboundCommand<CounterCommand>): Promise<void> {
    if (this.sendError) {
      return Promise.reject(this.sendError)
    }

    this.sent.push(command)
    return Promise.resolve()
  }

  public requestReplay(afterSequence: number): Promise<void> {
    this.replayRequests.push(afterSequence)

    if (this.replayError) {
      return Promise.reject(this.replayError)
    }

    return Promise.resolve()
  }

  public close(): Promise<void> {
    this.closeCalls += 1
    return Promise.resolve()
  }

  public snapshot(state: number, sequence: number, presence?: readonly string[]): void {
    this.requiredSink().receiveSnapshot(state, sequence, presence)
  }

  public operations(
    operations: readonly { operationId: string; serverSeq: number; event: number }[],
    caughtUp = true,
  ): void {
    this.requiredSink().receiveOperations(operations, caughtUp)
  }

  public acknowledge(operationId: string, serverSeq: number): void {
    this.requiredSink().receiveAcknowledgement(operationId, serverSeq)
  }

  public reject(operationId: string, code = 'invalid', message = 'Rejected'): void {
    this.requiredSink().receiveRejection({ operationId, code, message })
  }

  public presence(participants: readonly string[]): void {
    this.requiredSink().receivePresence(participants)
  }

  public closeConnection(): void {
    this.requiredSink().connectionClosed()
  }

  private requiredSink(): SyncTransportSink<number, number, string> {
    if (!this.sink) {
      throw new Error('Transport has not been opened')
    }

    return this.sink
  }
}

class MemoryPersistence implements SyncPersistence<number, CounterCommand> {
  public state: PersistedSyncState<number, CounterCommand> | null
  public readonly writes: PersistedSyncState<number, CounterCommand>[] = []

  public constructor(initial: PersistedSyncState<number, CounterCommand> | null = null) {
    this.state = initial
  }

  public load(): Promise<PersistedSyncState<number, CounterCommand> | null> {
    return Promise.resolve(this.state)
  }

  public save(state: PersistedSyncState<number, CounterCommand>): Promise<void> {
    this.state = state
    this.writes.push(state)
    return Promise.resolve()
  }
}

const operationIds = [
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000102',
  '00000000-0000-4000-8000-000000000103',
]

function createCounterEngine(input?: {
  transport?: FakeTransport
  persistence?: SyncPersistence<number, CounterCommand>
  project?: (state: number, command: CounterCommand) => number
}) {
  const transport = input?.transport ?? new FakeTransport()
  let idIndex = 0
  const engine = createSyncEngine({
    initialState: 0,
    reduce: (state: number, event: number) => state + event,
    project:
      input?.project ??
      ((state: number, command: CounterCommand) => {
        if (command.blocked) {
          throw new Error('Projection blocked')
        }

        return state + command.amount
      }),
    transport,
    ...(input?.persistence ? { persistence: input.persistence } : {}),
    createOperationId: () => operationIds[idIndex++]!,
    now: () => '2026-08-07T08:00:00.000Z',
  })

  return { engine, transport }
}

describe('sync engine', () => {
  it('projects offline intent, sends it on connect, and confirms canonical operations', async () => {
    const persistence = new MemoryPersistence()
    const { engine, transport } = createCounterEngine({ persistence })
    const listener = vi.fn()
    const unsubscribe = engine.subscribe(listener)

    const command = engine.dispatch({ amount: 2 })

    expect(engine.getSnapshot()).toMatchObject({
      confirmedState: 0,
      projectedState: 2,
      phase: 'offline',
      pending: [{ status: 'queued' }],
    })

    await engine.connect()
    expect(transport.resumeFrom).toBe(0)
    expect(transport.sent).toEqual([command])
    expect(engine.getSnapshot().pending[0]?.status).toBe('sent')

    transport.acknowledge(command.operationId, 1)
    expect(engine.getSnapshot().pending[0]).toMatchObject({
      status: 'acknowledged',
      acknowledgedSeq: 1,
    })

    transport.operations([{ operationId: command.operationId, serverSeq: 1, event: 2 }])
    await engine.flush()

    expect(engine.getSnapshot()).toMatchObject({
      confirmedState: 2,
      projectedState: 2,
      sequence: 1,
      pending: [],
      phase: 'live',
    })
    expect(persistence.state?.sequence).toBe(1)
    expect(listener).toHaveBeenCalled()

    unsubscribe()
    const calls = listener.mock.calls.length
    transport.presence(['Ada'])
    expect(listener).toHaveBeenCalledTimes(calls)
  })

  it('hydrates confirmed state and queued commands before opening the transport', async () => {
    const persistence = new MemoryPersistence({
      confirmedState: 5,
      sequence: 2,
      pending: [
        {
          operationId: operationIds[0]!,
          baseSeq: 2,
          command: { amount: 3 },
          createdAt: '2026-08-07T07:00:00.000Z',
        },
      ],
    })
    const { engine, transport } = createCounterEngine({ persistence })

    await engine.connect()

    expect(transport.resumeFrom).toBe(2)
    expect(transport.sent).toHaveLength(1)
    expect(engine.getSnapshot()).toMatchObject({
      confirmedState: 5,
      projectedState: 8,
      sequence: 2,
    })

    await engine.connect()
    expect(transport.sent).toHaveLength(1)
  })

  it('coalesces connect calls while persistence is still loading', async () => {
    let releaseLoad: (() => void) | undefined
    const persistence: SyncPersistence<number, CounterCommand> = {
      load: async () =>
        new Promise((resolve) => {
          releaseLoad = () => resolve(null)
        }),
      save: () => Promise.resolve(),
    }
    const transport = new FakeTransport()
    const open = vi.spyOn(transport, 'open')
    const { engine } = createCounterEngine({ persistence, transport })

    const firstConnect = engine.connect()
    const secondConnect = engine.connect()
    await vi.waitFor(() => expect(releaseLoad).toBeTypeOf('function'))
    releaseLoad?.()
    await Promise.all([firstConnect, secondConnect])

    expect(open).toHaveBeenCalledOnce()
  })

  it('rebases remaining optimistic commands after a rejection', async () => {
    const { engine, transport } = createCounterEngine()
    await engine.connect()
    const first = engine.dispatch({ amount: 1 })
    const rejected = engine.dispatch({ amount: 5 })
    engine.dispatch({ amount: 2 })

    expect(engine.getSnapshot().projectedState).toBe(8)
    transport.reject(rejected.operationId, 'target_missing', 'Counter disappeared')

    expect(engine.getSnapshot()).toMatchObject({
      projectedState: 3,
      lastRejection: {
        operationId: rejected.operationId,
        code: 'target_missing',
      },
    })
    expect(engine.getSnapshot().pending.map(({ operationId }) => operationId)).toEqual([
      first.operationId,
      operationIds[2],
    ])
  })

  it('enters recovery on a sequence gap and applies contiguous replay only', async () => {
    const { engine, transport } = createCounterEngine()
    await engine.connect()

    transport.operations([{ operationId: operationIds[1]!, serverSeq: 2, event: 2 }])
    expect(engine.getSnapshot()).toMatchObject({ phase: 'recovering', confirmedState: 0 })
    expect(transport.replayRequests).toEqual([0])

    transport.operations(
      [
        { operationId: operationIds[0]!, serverSeq: 1, event: 1 },
        { operationId: operationIds[1]!, serverSeq: 2, event: 2 },
      ],
      true,
    )

    expect(engine.getSnapshot()).toMatchObject({
      phase: 'live',
      confirmedState: 3,
      projectedState: 3,
      sequence: 2,
    })
  })

  it('keeps a partial contiguous replay live until a gap is observed', async () => {
    const { engine, transport } = createCounterEngine()
    await engine.connect()

    transport.operations([{ operationId: operationIds[0]!, serverSeq: 1, event: 1 }], false)

    expect(engine.getSnapshot()).toMatchObject({
      phase: 'live',
      confirmedState: 1,
      sequence: 1,
    })
  })

  it('removes a matching pending command when a duplicate operation follows a snapshot', async () => {
    const { engine, transport } = createCounterEngine()
    await engine.connect()
    const command = engine.dispatch({ amount: 2 })

    transport.snapshot(4, 1, ['Ada'])
    expect(engine.getSnapshot()).toMatchObject({ projectedState: 6, presence: ['Ada'] })

    transport.operations([{ operationId: command.operationId, serverSeq: 1, event: 2 }])
    expect(engine.getSnapshot()).toMatchObject({
      confirmedState: 4,
      projectedState: 4,
      pending: [],
    })
  })

  it('marks commands that cannot be optimistically projected without dropping them', () => {
    const { engine } = createCounterEngine({
      project: (state, command) => {
        if (command.blocked) {
          throw new Error('Projection blocked')
        }

        return state + command.amount
      },
    })

    engine.dispatch({ amount: 3, blocked: true })

    expect(engine.getSnapshot()).toMatchObject({
      projectedState: 0,
      pending: [
        {
          projection: 'blocked',
          projectionError: 'Projection blocked',
        },
      ],
    })
  })

  it('uses an injected projection error description', () => {
    const transport = new FakeTransport()
    const engine = createSyncEngine({
      initialState: 0,
      reduce: (state: number, event: number) => state + event,
      project: () => {
        throw new Error('internal detail')
      },
      transport,
      describeProjectionError: () => 'safe projection failure',
    })

    const command = engine.dispatch({ amount: 1 })

    expect(command.operationId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(engine.getSnapshot().pending[0]).toMatchObject({
      projectionError: 'safe projection failure',
    })
  })

  it('returns offline when sending or replay recovery fails', async () => {
    const sendTransport = new FakeTransport()
    sendTransport.sendError = new Error('network unavailable')
    const { engine: sendEngine } = createCounterEngine({ transport: sendTransport })
    await sendEngine.connect()
    sendEngine.dispatch({ amount: 1 })
    await vi.waitFor(() => expect(sendEngine.getSnapshot().phase).toBe('offline'))

    const replayTransport = new FakeTransport()
    replayTransport.replayError = new Error('replay unavailable')
    const { engine: replayEngine } = createCounterEngine({ transport: replayTransport })
    await replayEngine.connect()
    replayTransport.operations([{ operationId: operationIds[1]!, serverSeq: 2, event: 2 }])
    await vi.waitFor(() => expect(replayEngine.getSnapshot().phase).toBe('offline'))
  })

  it('does not resurrect a connection closed during its handshake', async () => {
    const transport = new FakeTransport()
    transport.closeDuringOpen = true
    const { engine } = createCounterEngine({ transport })

    await engine.connect()

    expect(engine.getSnapshot().phase).toBe('offline')
    expect(transport.sent).toEqual([])
  })

  it('propagates open failures and makes disconnect idempotent', async () => {
    const failedTransport = new FakeTransport()
    failedTransport.openError = new Error('handshake rejected')
    const { engine: failedEngine } = createCounterEngine({ transport: failedTransport })

    await expect(failedEngine.connect()).rejects.toThrow('handshake rejected')
    expect(failedEngine.getSnapshot().phase).toBe('offline')

    const { engine, transport } = createCounterEngine()
    await engine.disconnect()
    expect(transport.closeCalls).toBe(0)
    await engine.connect()
    transport.presence(['Ada', 'Lin'])
    expect(engine.getSnapshot().presence).toEqual(['Ada', 'Lin'])
    await engine.disconnect()
    await engine.disconnect()
    expect(transport.closeCalls).toBe(1)
  })

  it('ignores snapshots older than the confirmed sequence', async () => {
    const { engine, transport } = createCounterEngine()
    await engine.connect()
    transport.operations([{ operationId: operationIds[0]!, serverSeq: 1, event: 3 }])
    transport.snapshot(100, 0)

    expect(engine.getSnapshot()).toMatchObject({ confirmedState: 3, sequence: 1 })
  })

  it('ignores acknowledgements and rejections for unknown operations', async () => {
    const { engine, transport } = createCounterEngine()
    await engine.connect()
    const listener = vi.fn()
    engine.subscribe(listener)

    transport.acknowledge(operationIds[0]!, 1)
    transport.reject(operationIds[1]!)

    expect(listener).not.toHaveBeenCalled()
    expect(engine.getSnapshot().lastRejection).toBeNull()
  })

  it('does not acknowledge the same pending command twice', async () => {
    const { engine, transport } = createCounterEngine()
    await engine.connect()
    const command = engine.dispatch({ amount: 1 })
    transport.acknowledge(command.operationId, 1)
    const acknowledgedSnapshot = engine.getSnapshot()

    transport.acknowledge(command.operationId, 1)

    expect(engine.getSnapshot()).toBe(acknowledgedSnapshot)
  })

  it('serializes persistence writes so an older slow save cannot win', async () => {
    let releaseFirstSave: (() => void) | undefined
    const persistedSequences: number[] = []
    const persistence: SyncPersistence<number, CounterCommand> = {
      load: () => Promise.resolve(null),
      save: async (state) => {
        if (persistedSequences.length === 0) {
          await new Promise<void>((resolve) => {
            releaseFirstSave = resolve
          })
        }

        persistedSequences.push(state.sequence)
      },
    }
    const { engine, transport } = createCounterEngine({ persistence })
    await engine.connect()
    const command = engine.dispatch({ amount: 1 })
    transport.operations([{ operationId: command.operationId, serverSeq: 1, event: 1 }])

    await vi.waitFor(() => expect(releaseFirstSave).toBeTypeOf('function'))
    expect(persistedSequences).toEqual([])
    releaseFirstSave?.()
    await engine.flush()

    expect(persistedSequences.at(-1)).toBe(1)
  })

  it('continues persisting after a failed save', async () => {
    let attempts = 0
    const persistence: SyncPersistence<number, CounterCommand> = {
      load: () => Promise.resolve(null),
      save: () => {
        attempts += 1

        if (attempts === 1) {
          return Promise.reject(new Error('storage temporarily unavailable'))
        }

        return Promise.resolve()
      },
    }
    const { engine } = createCounterEngine({ persistence })
    await engine.connect()
    engine.dispatch({ amount: 1 })
    engine.dispatch({ amount: 2 })
    await engine.flush()

    expect(attempts).toBeGreaterThanOrEqual(2)
  })

  it('resets sent commands to queued when the connection closes', async () => {
    const { engine, transport } = createCounterEngine()
    await engine.connect()
    engine.dispatch({ amount: 1 })
    await vi.waitFor(() => expect(engine.getSnapshot().pending[0]?.status).toBe('sent'))

    transport.closeConnection()

    expect(engine.getSnapshot()).toMatchObject({
      phase: 'offline',
      pending: [{ status: 'queued', acknowledgedSeq: null }],
    })
  })
})
