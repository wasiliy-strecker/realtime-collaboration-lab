import { parseClientMessage, protocolVersion } from '@realtime-collaboration/protocol'

import type { CollaborationStore } from './collaboration.js'
import type { GatewayConnection, RoomHub } from './room-hub.js'

const policyViolationCode = 1008
const unsupportedDataCode = 1003

export class ConnectionController {
  public constructor(
    private readonly store: CollaborationStore,
    private readonly hub: RoomHub,
    private readonly now: () => number = Date.now,
  ) {}

  public async handle(
    connection: GatewayConnection,
    data: Buffer,
    isBinary: boolean,
  ): Promise<void> {
    if (isBinary) {
      this.hub.close(connection, unsupportedDataCode, 'Binary messages are not supported')
      return
    }

    let input: unknown

    try {
      input = JSON.parse(data.toString('utf8'))
    } catch {
      this.hub.close(connection, policyViolationCode, 'Message must be valid JSON')
      return
    }

    const parsed = parseClientMessage(input)

    if (parsed.type === 'pong') {
      this.hub.markPong(connection)
      return
    }

    if (!connection.limiter.consume(this.now())) {
      if (parsed.type === 'command') {
        this.hub.send(connection, {
          type: 'reject',
          protocolVersion,
          operationId: parsed.operationId,
          code: 'rate_limited',
          message: 'Command rate limit exceeded',
        })
      } else {
        this.hub.close(connection, policyViolationCode, 'Message rate limit exceeded')
      }

      return
    }

    if (parsed.type === 'hello') {
      await this.hub.join(connection, parsed)
      return
    }

    if (!connection.boardId || parsed.boardId !== connection.boardId) {
      this.hub.close(connection, policyViolationCode, 'Message board does not match connection')
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

    const result = await this.store.applyCommand({
      boardId: parsed.boardId,
      actorId: connection.identity.actorId,
      operationId: parsed.operationId,
      baseSeq: parsed.baseSeq,
      command: parsed.command,
    })

    if (result.kind === 'board-not-found') {
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
      this.hub.send(connection, {
        type: 'reject',
        protocolVersion,
        operationId: parsed.operationId,
        code: result.code,
        message: result.message,
      })
      return
    }

    this.hub.send(connection, {
      type: 'ack',
      protocolVersion,
      operationId: result.operation.operationId,
      serverSeq: result.operation.serverSeq,
    })
    this.hub.scheduleBoardPump(parsed.boardId)
  }
}
