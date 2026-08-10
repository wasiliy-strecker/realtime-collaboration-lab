import {
  parseClientMessage,
  protocolVersion,
  type ClientMessage,
} from '@realtime-collaboration/protocol'

import type { CollaborationStore } from './collaboration.js'
import { noopGatewayObserver, type CommandOutcome, type GatewayObserver } from './observability.js'
import type { GatewayConnection, RoomHub } from './room-hub.js'

const policyViolationCode = 1008
const unsupportedDataCode = 1003

export class ConnectionController {
  public constructor(
    private readonly store: CollaborationStore,
    private readonly hub: RoomHub,
    private readonly now: () => number = Date.now,
    private readonly observer: GatewayObserver = noopGatewayObserver,
  ) {}

  public async handle(
    connection: GatewayConnection,
    data: Buffer,
    isBinary: boolean,
  ): Promise<void> {
    if (isBinary) {
      this.hub.close(
        connection,
        unsupportedDataCode,
        'Binary messages are not supported',
        'protocol_violation',
      )
      return
    }

    let input: unknown

    try {
      input = JSON.parse(data.toString('utf8'))
    } catch {
      this.hub.close(
        connection,
        policyViolationCode,
        'Message must be valid JSON',
        'protocol_violation',
      )
      return
    }

    const parsed = parseClientMessage(input)

    if (parsed.type === 'pong') {
      this.hub.markPong(connection)
      return
    }

    if (!connection.limiter.consume(this.now())) {
      this.observer.observe({
        type: 'rate_limit.reached',
        boardId: connection.boardId,
        clientId: connection.clientId,
        messageType: parsed.type,
      })

      if (parsed.type === 'command') {
        this.recordCommand(parsed, 'rate_limited', this.now())
        this.hub.send(connection, {
          type: 'reject',
          protocolVersion,
          operationId: parsed.operationId,
          code: 'rate_limited',
          message: 'Command rate limit exceeded',
        })
      } else {
        this.hub.close(
          connection,
          policyViolationCode,
          'Message rate limit exceeded',
          'rate_limited',
        )
      }

      return
    }

    if (parsed.type === 'hello') {
      await this.hub.join(connection, parsed)
      return
    }

    if (!connection.boardId || parsed.boardId !== connection.boardId) {
      this.hub.close(
        connection,
        policyViolationCode,
        'Message board does not match connection',
        'protocol_violation',
      )
      return
    }

    if (parsed.type === 'presence') {
      await this.hub.updatePresence(connection, parsed.selectedCardId, parsed.editingCardId)
      return
    }

    if (parsed.type === 'replay-request') {
      await this.hub.replay(connection, parsed.afterSeq)
      return
    }

    const startedAt = this.now()
    let result: Awaited<ReturnType<CollaborationStore['applyCommand']>>

    try {
      result = await this.store.applyCommand({
        boardId: parsed.boardId,
        actorId: connection.identity.actorId,
        operationId: parsed.operationId,
        baseSeq: parsed.baseSeq,
        command: parsed.command,
      })
    } catch (error) {
      this.recordCommand(parsed, 'error', startedAt)
      throw error
    }

    if (result.kind === 'board-not-found') {
      this.recordCommand(parsed, 'board_not_found', startedAt)
      this.hub.send(connection, {
        type: 'reject',
        protocolVersion,
        operationId: parsed.operationId,
        code: 'target_missing',
        message: 'Board does not exist',
      })
      return
    }

    if (result.kind === 'rejected') {
      this.recordCommand(parsed, 'rejected', startedAt)
      this.hub.send(connection, {
        type: 'reject',
        protocolVersion,
        operationId: parsed.operationId,
        code: result.code,
        message: result.message,
      })
      return
    }

    this.recordCommand(parsed, result.kind, startedAt)
    this.hub.send(connection, {
      type: 'ack',
      protocolVersion,
      operationId: result.operation.operationId,
      serverSeq: result.operation.serverSeq,
    })
    this.hub.scheduleBoardPump(parsed.boardId)
  }

  private recordCommand(
    message: Extract<ClientMessage, { readonly type: 'command' }>,
    outcome: CommandOutcome,
    startedAt: number,
  ): void {
    this.observer.observe({
      type: 'command.completed',
      boardId: message.boardId,
      operationId: message.operationId,
      commandType: message.command.type,
      outcome,
      durationMs: this.now() - startedAt,
    })
  }
}
