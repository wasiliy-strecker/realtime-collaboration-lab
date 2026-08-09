import {
  parseServerMessage,
  protocolVersion,
  type BoardCommand,
  type BoardEvent,
  type BoardSnapshot,
  type ParticipantPresence,
  type ServerMessage,
} from '@realtime-collaboration/protocol'
import type {
  OutboundCommand,
  SyncTransport,
  SyncTransportSink,
} from '@realtime-collaboration/sync-engine'

import type { PresenceSelection } from './types.js'

export interface BoardTransportOptions {
  readonly boardId: string
  readonly clientId: string
  readonly url: string
  readonly createSocket?: (url: string) => WebSocket
  readonly onUnexpectedClose?: () => void
}

export class BoardWebSocketTransport implements SyncTransport<
  BoardSnapshot,
  BoardCommand,
  BoardEvent,
  ParticipantPresence
> {
  private socket: WebSocket | null = null
  private sink: SyncTransportSink<BoardSnapshot, BoardEvent, ParticipantPresence> | null = null
  private intendedClose = false

  public constructor(private readonly options: BoardTransportOptions) {}

  public open(input: {
    readonly resumeFrom: number
    readonly sink: SyncTransportSink<BoardSnapshot, BoardEvent, ParticipantPresence>
  }): Promise<void> {
    if (this.socket && this.socket.readyState <= 1) {
      return Promise.resolve()
    }

    this.intendedClose = false
    this.sink = input.sink
    const socket = (this.options.createSocket ?? ((url: string) => new WebSocket(url)))(
      this.options.url,
    )
    this.socket = socket

    return new Promise((resolve, reject) => {
      let opened = false

      socket.addEventListener('open', () => {
        try {
          this.sendJson({
            type: 'hello',
            protocolVersion,
            boardId: this.options.boardId,
            clientId: this.options.clientId,
            lastSeenSeq: input.resumeFrom,
          })
          opened = true
          resolve()
        } catch (error) {
          reject(asError(error))
        }
      })
      socket.addEventListener('message', (event) => this.receive(event.data))
      socket.addEventListener('error', () => {
        if (!opened) {
          reject(new Error('WebSocket connection failed'))
          socket.close()
        }
      })
      socket.addEventListener('close', (event) => {
        if (this.socket === socket) {
          this.socket = null
        }

        if (!opened) {
          reject(new Error(event.reason || 'WebSocket closed before it opened'))
        }

        if (!this.intendedClose) {
          input.sink.connectionClosed()
          this.options.onUnexpectedClose?.()
        }
      })
    })
  }

  public send(command: OutboundCommand<BoardCommand>): Promise<void> {
    this.sendJson({
      type: 'command',
      protocolVersion,
      boardId: this.options.boardId,
      ...command,
    })
    return Promise.resolve()
  }

  public requestReplay(afterSequence: number): Promise<void> {
    this.sendJson({
      type: 'replay-request',
      protocolVersion,
      boardId: this.options.boardId,
      afterSeq: afterSequence,
    })
    return Promise.resolve()
  }

  public sendPresence(presence: PresenceSelection): boolean {
    if (!this.socket || this.socket.readyState !== 1) {
      return false
    }

    this.sendJson({
      type: 'presence',
      protocolVersion,
      boardId: this.options.boardId,
      ...presence,
    })
    return true
  }

  public close(): Promise<void> {
    this.intendedClose = true
    this.socket?.close(1000, 'Client disconnected')
    this.socket = null
    return Promise.resolve()
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') {
      this.closeInvalidFrame('Server message must be text')
      return
    }

    try {
      const input: unknown = JSON.parse(data)
      const message = parseServerMessage(input)
      this.route(message)
    } catch {
      this.closeInvalidFrame('Server message violated the protocol')
    }
  }

  private route(message: ServerMessage): void {
    const sink = this.requiredSink()

    switch (message.type) {
      case 'snapshot':
        if (message.board.boardId !== this.options.boardId) {
          this.closeInvalidFrame('Snapshot belongs to another board')
          return
        }
        sink.receiveSnapshot(message.board, message.board.sequence, message.participants)
        return
      case 'replay':
        sink.receiveOperations(
          message.operations.map(({ operationId, serverSeq, event }) => ({
            operationId,
            serverSeq,
            event,
          })),
          message.caughtUp,
        )
        return
      case 'operation':
        sink.receiveOperations(
          [
            {
              operationId: message.operation.operationId,
              serverSeq: message.operation.serverSeq,
              event: message.operation.event,
            },
          ],
          true,
        )
        return
      case 'ack':
        sink.receiveAcknowledgement(message.operationId, message.serverSeq)
        return
      case 'reject':
        sink.receiveRejection({
          operationId: message.operationId,
          code: message.code,
          message: message.message,
        })
        return
      case 'presence':
        sink.receivePresence(message.participants)
        return
      case 'ping':
        this.sendJson({ type: 'pong', protocolVersion, nonce: message.nonce })
    }
  }

  private sendJson(message: object): void {
    if (!this.socket || this.socket.readyState !== 1) {
      throw new Error('WebSocket is not open')
    }

    this.socket.send(JSON.stringify(message))
  }

  private closeInvalidFrame(reason: string): void {
    this.socket?.close(1008, reason)
  }

  private requiredSink(): SyncTransportSink<BoardSnapshot, BoardEvent, ParticipantPresence> {
    if (!this.sink) {
      throw new Error('Transport has not been opened')
    }

    return this.sink
  }
}

export function collaborationWebSocketUrl(location: Pick<Location, 'host' | 'protocol'>): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}/ws`
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('WebSocket operation failed')
}
