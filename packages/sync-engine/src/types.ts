export type ConnectionPhase = 'offline' | 'connecting' | 'live' | 'recovering'

export type PendingCommandStatus = 'queued' | 'sent' | 'acknowledged'

export interface OutboundCommand<Command> {
  readonly operationId: string
  readonly baseSeq: number
  readonly command: Command
}

export interface PendingCommand<Command> extends OutboundCommand<Command> {
  readonly createdAt: string
  readonly status: PendingCommandStatus
  readonly acknowledgedSeq: number | null
  readonly projection: 'applied' | 'blocked'
  readonly projectionError: string | null
}

export interface SyncOperation<Event> {
  readonly operationId: string
  readonly serverSeq: number
  readonly event: Event
}

export interface SyncRejection {
  readonly operationId: string
  readonly code: string
  readonly message: string
}

export interface PersistedPendingCommand<Command> extends OutboundCommand<Command> {
  readonly createdAt: string
}

export interface PersistedSyncState<State, Command> {
  readonly confirmedState: State
  readonly sequence: number
  readonly pending: readonly PersistedPendingCommand<Command>[]
}

export interface SyncSnapshot<State, Command, Presence> {
  readonly confirmedState: State
  readonly projectedState: State
  readonly sequence: number
  readonly pending: readonly PendingCommand<Command>[]
  readonly phase: ConnectionPhase
  readonly presence: readonly Presence[]
  readonly lastRejection: SyncRejection | null
}

export interface SyncPersistence<State, Command> {
  load(): Promise<PersistedSyncState<State, Command> | null>
  save(state: PersistedSyncState<State, Command>): Promise<void>
}

export interface SyncTransportSink<State, Event, Presence> {
  receiveSnapshot(state: State, sequence: number, presence?: readonly Presence[]): void
  receiveOperations(operations: readonly SyncOperation<Event>[], caughtUp: boolean): void
  receiveAcknowledgement(operationId: string, serverSeq: number): void
  receiveRejection(rejection: SyncRejection): void
  receivePresence(presence: readonly Presence[]): void
  connectionClosed(): void
}

export interface SyncTransport<State, Command, Event, Presence> {
  open(input: {
    readonly resumeFrom: number
    readonly sink: SyncTransportSink<State, Event, Presence>
  }): Promise<void>
  send(command: OutboundCommand<Command>): Promise<void>
  requestReplay(afterSequence: number): Promise<void>
  close(): Promise<void>
}

export interface SyncEngineOptions<State, Command, Event, Presence> {
  readonly initialState: State
  readonly reduce: (state: State, event: Event) => State
  readonly project: (state: State, command: Command) => State
  readonly transport: SyncTransport<State, Command, Event, Presence>
  readonly persistence?: SyncPersistence<State, Command>
  readonly createOperationId?: () => string
  readonly now?: () => string
  readonly describeProjectionError?: (error: unknown) => string
}

export interface SyncEngine<State, Command, Presence> {
  connect(): Promise<void>
  disconnect(): Promise<void>
  dispatch(command: Command): OutboundCommand<Command>
  getSnapshot(): SyncSnapshot<State, Command, Presence>
  subscribe(listener: () => void): () => void
  flush(): Promise<void>
}
