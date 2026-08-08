import {
  appliedOperationSchema,
  boardSnapshotSchema,
  createBoardSnapshot,
  type AppliedOperation,
  type BoardSnapshot,
} from '@realtime-collaboration/protocol'

import {
  applyCommandToBoard,
  rejectionFor,
  type ApplyCommandInput,
  type ApplyCommandResult,
  type CollaborationStore,
} from '../src/collaboration.js'
import type {
  CollaborationNotificationHandlers,
  CollaborationNotifier,
  PresenceNotification,
} from '../src/postgres/notifier.js'
import type { GatewaySocket } from '../src/room-hub.js'

export const ids = {
  actor: '00000000-0000-4000-8000-000000000201',
  actorTwo: '00000000-0000-4000-8000-000000000202',
  board: '00000000-0000-4000-8000-000000000100',
  card: '00000000-0000-4000-8000-000000000203',
  cardTwo: '00000000-0000-4000-8000-000000000204',
  client: '00000000-0000-4000-8000-000000000205',
  operation: '00000000-0000-4000-8000-000000000206',
  operationTwo: '00000000-0000-4000-8000-000000000207',
} as const

export class MemoryCollaborationStore implements CollaborationStore {
  public board: BoardSnapshot | null = createBoardSnapshot({
    boardId: ids.board,
    title: 'August release',
  })
  public readonly operations: AppliedOperation[] = []

  public getBoard(boardId: string): Promise<BoardSnapshot | null> {
    return Promise.resolve(this.board?.boardId === boardId ? this.board : null)
  }

  public listOperations(
    boardId: string,
    afterSequence: number,
    limit = 500,
  ): Promise<readonly AppliedOperation[]> {
    if (this.board?.boardId !== boardId) {
      return Promise.resolve([])
    }

    return Promise.resolve(
      this.operations.filter(({ serverSeq }) => serverSeq > afterSequence).slice(0, limit),
    )
  }

  public applyCommand(input: ApplyCommandInput): Promise<ApplyCommandResult> {
    if (!this.board || this.board.boardId !== input.boardId) {
      return Promise.resolve({ kind: 'board-not-found' })
    }

    const duplicate = this.operations.find(({ operationId }) => operationId === input.operationId)

    if (duplicate) {
      return Promise.resolve({ kind: 'duplicate', operation: duplicate })
    }

    try {
      const transition = applyCommandToBoard(this.board, input.command)
      const serverSeq = this.board.sequence + 1
      const operation = appliedOperationSchema.parse({
        operationId: input.operationId,
        serverSeq,
        actorId: input.actorId,
        appliedAt: `2026-08-08T08:00:0${serverSeq}+02:00`,
        event: transition.event,
      })
      this.board = boardSnapshotSchema.parse({ ...transition.board, sequence: serverSeq })
      this.operations.push(operation)
      return Promise.resolve({ kind: 'applied', operation })
    } catch (error) {
      return Promise.resolve(rejectionFor(error))
    }
  }
}

export class FakeNotifier implements CollaborationNotifier {
  public handlers: CollaborationNotificationHandlers | null = null
  public readonly published: PresenceNotification[] = []
  public startCalls = 0
  public stopCalls = 0

  public start(handlers: CollaborationNotificationHandlers): Promise<void> {
    this.handlers = handlers
    this.startCalls += 1
    return Promise.resolve()
  }

  public publishPresence(notification: PresenceNotification): Promise<void> {
    this.published.push(notification)
    return Promise.resolve()
  }

  public stop(): Promise<void> {
    this.handlers = null
    this.stopCalls += 1
    return Promise.resolve()
  }
}

export class FakeSocket implements GatewaySocket {
  public bufferedAmount = 0
  public readyState = 1
  public readonly messages: unknown[] = []
  public readonly closes: { readonly code?: number; readonly reason?: string }[] = []

  public send(data: string): void {
    this.messages.push(JSON.parse(data) as unknown)
  }

  public close(code?: number, reason?: string): void {
    this.readyState = 3
    this.closes.push({ ...(code === undefined ? {} : { code }), ...(reason ? { reason } : {}) })
  }
}
