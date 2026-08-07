import type {
  ConnectionPhase,
  OutboundCommand,
  PendingCommand,
  PersistedPendingCommand,
  PersistedSyncState,
  SyncEngine,
  SyncEngineOptions,
  SyncOperation,
  SyncRejection,
  SyncSnapshot,
  SyncTransportSink,
} from './types.js'

export function createSyncEngine<State, Command, Event, Presence>(
  options: SyncEngineOptions<State, Command, Event, Presence>,
): SyncEngine<State, Command, Presence> {
  let confirmedState = options.initialState
  let projectedState = options.initialState
  let sequence = 0
  let pending: PendingCommand<Command>[] = []
  let phase: ConnectionPhase = 'offline'
  let presence: readonly Presence[] = []
  let lastRejection: SyncRejection | null = null
  let hydrated = false
  let persistenceChain = Promise.resolve()
  let cachedSnapshot = buildSnapshot()
  const listeners = new Set<() => void>()

  const sink: SyncTransportSink<State, Event, Presence> = {
    receiveSnapshot,
    receiveOperations,
    receiveAcknowledgement,
    receiveRejection,
    receivePresence,
    connectionClosed,
  }

  return {
    connect,
    disconnect,
    dispatch,
    getSnapshot: () => cachedSnapshot,
    subscribe,
    flush: () => persistenceChain,
  }

  async function connect(): Promise<void> {
    if (phase !== 'offline') {
      return
    }

    setPhase('connecting')

    try {
      await hydrate()
      await options.transport.open({ resumeFrom: sequence, sink })

      if (currentPhase() === 'connecting') {
        setPhase('live')
      }

      if (currentPhase() === 'live') {
        await sendQueuedCommands()
      }
    } catch (error) {
      connectionClosed()
      throw error
    }
  }

  async function disconnect(): Promise<void> {
    if (phase === 'offline') {
      return
    }

    await options.transport.close()
    connectionClosed()
  }

  function dispatch(command: Command): OutboundCommand<Command> {
    const outbound: OutboundCommand<Command> = {
      operationId: (options.createOperationId ?? defaultOperationId)(),
      baseSeq: sequence,
      command,
    }

    pending = [
      ...pending,
      {
        ...outbound,
        createdAt: (options.now ?? defaultNow)(),
        status: 'queued',
        acknowledgedSeq: null,
        projection: 'applied',
        projectionError: null,
      },
    ]
    recomputeProjection()
    persistAndEmit()

    if (phase === 'live') {
      void sendPending(outbound.operationId)
    }

    return outbound
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  async function hydrate(): Promise<void> {
    if (hydrated) {
      return
    }

    hydrated = true

    if (!options.persistence) {
      return
    }

    const stored = await options.persistence.load()

    if (!stored) {
      return
    }

    if (stored.sequence >= sequence) {
      confirmedState = stored.confirmedState
      sequence = stored.sequence
    }

    const inMemory = new Set(pending.map((candidate) => candidate.operationId))
    const restored = stored.pending
      .filter((candidate) => !inMemory.has(candidate.operationId))
      .map(toPendingCommand)
    pending = [...restored, ...pending]
    recomputeProjection()
    emit()
  }

  function receiveSnapshot(
    state: State,
    snapshotSequence: number,
    snapshotPresence: readonly Presence[] = presence,
  ): void {
    if (snapshotSequence < sequence) {
      return
    }

    confirmedState = state
    sequence = snapshotSequence
    presence = [...snapshotPresence]
    recomputeProjection()
    persistAndEmit()
  }

  function receiveOperations(operations: readonly SyncOperation<Event>[], caughtUp: boolean): void {
    let changed = false

    for (const operation of operations) {
      const pendingCount = pending.length
      pending = pending.filter((candidate) => candidate.operationId !== operation.operationId)
      changed ||= pending.length !== pendingCount

      if (operation.serverSeq <= sequence) {
        continue
      }

      if (operation.serverSeq !== sequence + 1) {
        setPhase('recovering')
        requestReplay()
        recomputeProjection()

        if (changed) {
          persistAndEmit()
        }

        return
      }

      confirmedState = options.reduce(confirmedState, operation.event)
      sequence = operation.serverSeq
      changed = true
    }

    if (!changed && !(caughtUp && phase === 'recovering')) {
      return
    }

    if (caughtUp && phase === 'recovering') {
      phase = 'live'
    }

    recomputeProjection()
    persistAndEmit()
  }

  function receiveAcknowledgement(operationId: string, serverSeq: number): void {
    let changed = false
    pending = pending.map((candidate) => {
      if (candidate.operationId !== operationId || candidate.status === 'acknowledged') {
        return candidate
      }

      changed = true
      return {
        ...candidate,
        status: 'acknowledged',
        acknowledgedSeq: serverSeq,
      }
    })

    if (changed) {
      persistAndEmit()
    }
  }

  function receiveRejection(rejection: SyncRejection): void {
    const nextPending = pending.filter(
      (candidate) => candidate.operationId !== rejection.operationId,
    )

    if (nextPending.length === pending.length) {
      return
    }

    pending = nextPending
    lastRejection = rejection
    recomputeProjection()
    persistAndEmit()
  }

  function receivePresence(nextPresence: readonly Presence[]): void {
    presence = [...nextPresence]
    emit()
  }

  function connectionClosed(): void {
    const wasOffline = phase === 'offline'
    phase = 'offline'
    pending = pending.map((candidate) => ({
      ...candidate,
      status: 'queued',
      acknowledgedSeq: null,
    }))

    if (!wasOffline || pending.length > 0) {
      persistAndEmit()
    }
  }

  function setPhase(nextPhase: ConnectionPhase): void {
    if (phase === nextPhase) {
      return
    }

    phase = nextPhase
    emit()
  }

  function currentPhase(): ConnectionPhase {
    return phase
  }

  function requestReplay(): void {
    void options.transport.requestReplay(sequence).catch(connectionClosed)
  }

  async function sendQueuedCommands(): Promise<void> {
    for (const command of pending) {
      await sendPending(command.operationId)
    }
  }

  async function sendPending(operationId: string): Promise<void> {
    const candidate = pending.find((command) => command.operationId === operationId)

    if (!candidate || phase !== 'live') {
      return
    }

    try {
      await options.transport.send({
        operationId: candidate.operationId,
        baseSeq: candidate.baseSeq,
        command: candidate.command,
      })

      let changed = false
      pending = pending.map((command) => {
        if (command.operationId !== operationId || command.status !== 'queued') {
          return command
        }

        changed = true
        return { ...command, status: 'sent' }
      })

      if (changed) {
        persistAndEmit()
      }
    } catch {
      connectionClosed()
    }
  }

  function recomputeProjection(): void {
    let nextState = confirmedState
    pending = pending.map((candidate) => {
      try {
        nextState = options.project(nextState, candidate.command)
        return {
          ...candidate,
          projection: 'applied',
          projectionError: null,
        }
      } catch (error) {
        return {
          ...candidate,
          projection: 'blocked',
          projectionError: (options.describeProjectionError ?? defaultProjectionError)(error),
        }
      }
    })
    projectedState = nextState
  }

  function persistAndEmit(): void {
    schedulePersistence()
    emit()
  }

  function schedulePersistence(): void {
    const persistence = options.persistence

    if (!persistence) {
      return
    }

    const state = persistedState()
    persistenceChain = persistenceChain.catch(() => undefined).then(() => persistence.save(state))
  }

  function persistedState(): PersistedSyncState<State, Command> {
    return {
      confirmedState,
      sequence,
      pending: pending.map(({ operationId, baseSeq, command, createdAt }) => ({
        operationId,
        baseSeq,
        command,
        createdAt,
      })),
    }
  }

  function emit(): void {
    cachedSnapshot = buildSnapshot()

    for (const listener of listeners) {
      listener()
    }
  }

  function buildSnapshot(): SyncSnapshot<State, Command, Presence> {
    return {
      confirmedState,
      projectedState,
      sequence,
      pending: [...pending],
      phase,
      presence: [...presence],
      lastRejection,
    }
  }
}

function toPendingCommand<Command>(
  command: PersistedPendingCommand<Command>,
): PendingCommand<Command> {
  return {
    ...command,
    status: 'queued',
    acknowledgedSeq: null,
    projection: 'applied',
    projectionError: null,
  }
}

function defaultOperationId(): string {
  return globalThis.crypto.randomUUID()
}

function defaultNow(): string {
  return new Date().toISOString()
}

function defaultProjectionError(error: unknown): string {
  return error instanceof Error ? error.message : 'Command cannot be projected'
}
