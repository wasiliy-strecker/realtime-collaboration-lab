import {
  applyBoardEvent,
  createBoardSnapshot,
  projectBoardCommand,
  type BoardCommand,
  type BoardEvent,
  type BoardSnapshot,
} from '@realtime-collaboration/protocol'
import { createSyncEngine } from '@realtime-collaboration/sync-engine'

import { boardPersistenceKey, createBoardPersistence, getOrCreateClientId } from './storage.js'
import { BoardWebSocketTransport } from './transport.js'
import type { BoardSyncEngine, DemoSession, PresenceSelection } from './types.js'

interface ClientRuntime {
  addEventListener(type: 'online', listener: () => void): void
  clearTimeout(handle: number): void
  removeEventListener(type: 'online', listener: () => void): void
  setTimeout(callback: () => void, delay: number): number
}

export interface CollaborationClientOptions {
  readonly session: DemoSession
  readonly localStorage: Storage
  readonly sessionStorage: Storage
  readonly webSocketUrl: string
  readonly createSocket?: (url: string) => WebSocket
  readonly runtime?: ClientRuntime
  readonly random?: () => number
}

export class BoardCollaborationClient {
  public readonly engine: BoardSyncEngine
  private readonly transport: BoardWebSocketTransport
  private readonly runtime: ClientRuntime
  private readonly random: () => number
  private reconnectAttempt = 0
  private reconnectTimer: number | null = null
  private presenceTimer: number | null = null
  private desiredPresence: PresenceSelection = {
    selectedCardId: null,
    editingCardId: null,
  }
  private stopped = true

  public constructor(options: CollaborationClientOptions) {
    this.runtime = options.runtime ?? window
    this.random = options.random ?? Math.random
    const clientId = getOrCreateClientId(options.sessionStorage)
    this.transport = new BoardWebSocketTransport({
      boardId: options.session.boardId,
      clientId,
      url: options.webSocketUrl,
      ...(options.createSocket ? { createSocket: options.createSocket } : {}),
      onUnexpectedClose: () => this.scheduleReconnect(),
    })
    this.engine = createSyncEngine({
      initialState: createBoardSnapshot({
        boardId: options.session.boardId,
        title: 'Release room',
      }),
      reduce: applyBoardOperationEvent,
      project: projectBoardCommand,
      transport: this.transport,
      persistence: createBoardPersistence(
        options.localStorage,
        boardPersistenceKey(options.session.actorId, options.session.boardId),
      ),
    })
  }

  public start(): void {
    if (!this.stopped) {
      return
    }

    this.stopped = false
    this.runtime.addEventListener('online', this.handleOnline)
    void this.connect()
  }

  public async stop(): Promise<void> {
    this.stopped = true
    this.runtime.removeEventListener('online', this.handleOnline)
    this.clearReconnectTimer()

    if (this.presenceTimer !== null) {
      this.runtime.clearTimeout(this.presenceTimer)
      this.presenceTimer = null
    }

    await this.engine.disconnect()

    if (!this.stopped) {
      void this.connect()
    }
  }

  public dispatch(command: BoardCommand): void {
    this.engine.dispatch(command)
  }

  public updatePresence(presence: PresenceSelection): void {
    this.desiredPresence = presence

    if (this.presenceTimer !== null) {
      return
    }

    this.presenceTimer = this.runtime.setTimeout(() => {
      this.presenceTimer = null
      this.transport.sendPresence(this.desiredPresence)
    }, 120)
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.engine.getSnapshot().phase !== 'offline') {
      return
    }

    try {
      await this.engine.connect()
      this.reconnectAttempt = 0
      this.transport.sendPresence(this.desiredPresence)
    } catch {
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) {
      return
    }

    const baseDelay = Math.min(1_000 * 2 ** this.reconnectAttempt, 10_000)
    const jitter = 0.8 + this.random() * 0.4
    this.reconnectAttempt += 1
    this.reconnectTimer = this.runtime.setTimeout(
      () => {
        this.reconnectTimer = null
        void this.connect()
      },
      Math.round(baseDelay * jitter),
    )
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) {
      return
    }

    this.runtime.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private readonly handleOnline = (): void => {
    this.clearReconnectTimer()
    void this.connect()
  }
}

function applyBoardOperationEvent(board: BoardSnapshot, event: BoardEvent): BoardSnapshot {
  return {
    ...applyBoardEvent(board, event),
    sequence: board.sequence + 1,
  }
}
