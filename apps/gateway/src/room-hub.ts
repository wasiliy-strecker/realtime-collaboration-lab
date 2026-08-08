import {
  protocolVersion,
  serverMessageSchema,
  type ParticipantPresence,
  type ServerMessage,
} from '@realtime-collaboration/protocol'

import type { CollaborationStore } from './collaboration.js'
import { TokenBucket } from './rate-limit.js'
import type { SessionIdentity } from './session.js'
import {
  type CollaborationNotifier,
  type PresenceNotification,
  presenceUpsert,
} from './postgres/notifier.js'

const openSocketState = 1
const normalShutdownCode = 1001
const policyViolationCode = 1008
const slowConsumerCode = 1013

export interface GatewayConnection {
  readonly socket: GatewaySocket
  readonly identity: SessionIdentity
  readonly limiter: TokenBucket
  clientId: string | null
  boardId: string | null
  lastDeliveredSeq: number
  phase: 'awaiting-hello' | 'catching-up' | 'live' | 'closed'
  lastPongAt: number
  pumpChain: Promise<void>
}

export interface GatewaySocket {
  readonly bufferedAmount: number
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
}

export class RoomHub {
  private readonly connections = new Set<GatewayConnection>()
  private readonly presenceByBoard = new Map<
    string,
    Map<string, { readonly participant: ParticipantPresence; readonly expiresAt: number }>
  >()

  public constructor(
    private readonly store: CollaborationStore,
    private readonly notifier: CollaborationNotifier,
    private readonly options: {
      readonly now?: () => number
      readonly maxBufferedBytes?: number
      readonly heartbeatTimeoutMs?: number
      readonly presenceTtlMs?: number
    } = {},
  ) {}

  public createConnection(
    socket: GatewayConnection['socket'],
    identity: SessionIdentity,
  ): GatewayConnection {
    const now = this.now()
    return {
      socket,
      identity,
      limiter: new TokenBucket(40, 20, now),
      clientId: null,
      boardId: null,
      lastDeliveredSeq: 0,
      phase: 'awaiting-hello',
      lastPongAt: now,
      pumpChain: Promise.resolve(),
    }
  }

  public async join(
    connection: GatewayConnection,
    input: {
      readonly boardId: string
      readonly clientId: string
      readonly lastSeenSeq: number | null
    },
  ): Promise<boolean> {
    if (connection.phase !== 'awaiting-hello') {
      this.close(connection, policyViolationCode, 'Hello was already received')
      return false
    }

    const board = await this.store.getBoard(input.boardId)

    if (!board) {
      this.close(connection, policyViolationCode, 'Board does not exist')
      return false
    }

    connection.phase = 'catching-up'
    connection.boardId = input.boardId
    connection.clientId = input.clientId
    this.connections.add(connection)

    if (input.lastSeenSeq === null || input.lastSeenSeq > board.sequence) {
      if (
        !this.send(connection, {
          type: 'snapshot',
          protocolVersion,
          board,
          participants: this.participants(input.boardId),
        })
      ) {
        return false
      }

      connection.lastDeliveredSeq = board.sequence
    } else {
      connection.lastDeliveredSeq = input.lastSeenSeq
      await this.replayTo(connection, board.sequence, true)
    }

    if (this.isClosed(connection)) {
      return false
    }

    connection.phase = 'live'
    await this.updatePresence(connection, null, null)
    this.schedulePump(connection)
    return true
  }

  public async replay(connection: GatewayConnection, afterSequence: number): Promise<void> {
    if (!connection.boardId || connection.phase === 'closed') {
      return
    }

    const board = await this.store.getBoard(connection.boardId)

    if (!board) {
      this.close(connection, policyViolationCode, 'Board does not exist')
      return
    }

    connection.lastDeliveredSeq = Math.min(afterSequence, board.sequence)
    await this.replayTo(connection, board.sequence, true)
  }

  public scheduleBoardPump(boardId: string): void {
    for (const connection of this.connections) {
      if (connection.boardId === boardId && connection.phase === 'live') {
        this.schedulePump(connection)
      }
    }
  }

  public send(connection: GatewayConnection, message: ServerMessage): boolean {
    if (connection.socket.readyState !== openSocketState || connection.phase === 'closed') {
      return false
    }

    if (connection.socket.bufferedAmount > (this.options.maxBufferedBytes ?? 512 * 1_024)) {
      this.close(connection, slowConsumerCode, 'Client is not consuming messages')
      return false
    }

    const validated = serverMessageSchema.parse(message)
    connection.socket.send(JSON.stringify(validated))
    return true
  }

  public async updatePresence(
    connection: GatewayConnection,
    selectedCardId: string | null,
    editingCardId: string | null,
  ): Promise<void> {
    if (!connection.boardId || !connection.clientId || connection.phase === 'closed') {
      return
    }

    const notification = presenceUpsert({
      boardId: connection.boardId,
      clientId: connection.clientId,
      participant: {
        actorId: connection.identity.actorId,
        displayName: connection.identity.displayName,
        selectedCardId,
        editingCardId,
        observedAt: new Date(this.now()).toISOString(),
      },
    })
    this.applyPresence(notification)
    await this.notifier.publishPresence(notification)
  }

  public markPong(connection: GatewayConnection): void {
    connection.lastPongAt = this.now()
  }

  public heartbeat(): void {
    const now = this.now()

    for (const connection of this.connections) {
      if (now - connection.lastPongAt > (this.options.heartbeatTimeoutMs ?? 30_000)) {
        this.close(connection, normalShutdownCode, 'Heartbeat timed out')
        continue
      }

      this.send(connection, {
        type: 'ping',
        protocolVersion,
        nonce: `${now}:${connection.clientId ?? 'pending'}`,
      })
    }

    for (const [boardId, entries] of this.presenceByBoard) {
      let changed = false

      for (const [clientId, entry] of entries) {
        if (entry.expiresAt <= now) {
          entries.delete(clientId)
          changed = true
        }
      }

      if (changed) {
        this.broadcastPresence(boardId)
      }
    }
  }

  public applyPresence(notification: PresenceNotification): void {
    const boardPresence =
      this.presenceByBoard.get(notification.boardId) ??
      new Map<string, { readonly participant: ParticipantPresence; readonly expiresAt: number }>()
    this.presenceByBoard.set(notification.boardId, boardPresence)

    if (notification.action === 'upsert') {
      boardPresence.set(notification.clientId, {
        participant: notification.participant,
        expiresAt: this.now() + (this.options.presenceTtlMs ?? 45_000),
      })
    } else {
      boardPresence.delete(notification.clientId)
    }

    this.broadcastPresence(notification.boardId)
  }

  public async leave(connection: GatewayConnection): Promise<void> {
    if (connection.phase === 'closed') {
      return
    }

    const { boardId, clientId } = connection
    connection.phase = 'closed'
    this.connections.delete(connection)

    if (boardId && clientId) {
      const notification: PresenceNotification = { action: 'remove', boardId, clientId }
      this.applyPresence(notification)
      await this.notifier.publishPresence(notification)
    }
  }

  public close(connection: GatewayConnection, code: number, reason: string): void {
    if (connection.phase === 'closed') {
      return
    }

    connection.socket.close(code, reason)
    void this.leave(connection).catch(() => undefined)
  }

  private schedulePump(connection: GatewayConnection): void {
    connection.pumpChain = connection.pumpChain
      .then(async () => {
        if (!connection.boardId || connection.phase !== 'live') {
          return
        }

        const board = await this.store.getBoard(connection.boardId)

        if (board) {
          await this.replayTo(connection, board.sequence, false)
        }
      })
      .catch(() => this.close(connection, normalShutdownCode, 'Replay failed'))
  }

  private async replayTo(
    connection: GatewayConnection,
    targetSequence: number,
    emitEmptyReplay: boolean,
  ): Promise<void> {
    const boardId = connection.boardId

    if (!boardId) {
      return
    }

    let sentBatch = false

    while (connection.lastDeliveredSeq < targetSequence && connection.phase !== 'closed') {
      const fromSeq = connection.lastDeliveredSeq
      const operations = await this.store.listOperations(boardId, fromSeq)

      if (operations.length === 0) {
        break
      }

      const toSeq = operations.at(-1)?.serverSeq ?? fromSeq
      const caughtUp = toSeq >= targetSequence

      if (
        !this.send(connection, {
          type: 'replay',
          protocolVersion,
          fromSeq,
          toSeq,
          operations: [...operations],
          caughtUp,
        })
      ) {
        return
      }

      connection.lastDeliveredSeq = toSeq
      sentBatch = true
    }

    if (emitEmptyReplay && !sentBatch && connection.phase !== 'closed') {
      this.send(connection, {
        type: 'replay',
        protocolVersion,
        fromSeq: connection.lastDeliveredSeq,
        toSeq: connection.lastDeliveredSeq,
        operations: [],
        caughtUp: true,
      })
    }
  }

  private broadcastPresence(boardId: string): void {
    const message: ServerMessage = {
      type: 'presence',
      protocolVersion,
      participants: this.participants(boardId),
    }

    for (const connection of this.connections) {
      if (connection.boardId === boardId && connection.phase !== 'closed') {
        this.send(connection, message)
      }
    }
  }

  private participants(boardId: string): ParticipantPresence[] {
    const entries = this.presenceByBoard.get(boardId)
    return entries ? [...entries.values()].map(({ participant }) => participant) : []
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private isClosed(connection: GatewayConnection): boolean {
    return connection.phase === 'closed'
  }
}
