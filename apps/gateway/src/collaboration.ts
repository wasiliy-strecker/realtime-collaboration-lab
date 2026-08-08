import {
  applyBoardEvent,
  BoardTransitionError,
  type AppliedOperation,
  type BoardCommand,
  type BoardEvent,
  type BoardSnapshot,
} from '@realtime-collaboration/protocol'

export const demoBoardId = '00000000-0000-4000-8000-000000000100'

export interface ApplyCommandInput {
  readonly boardId: string
  readonly actorId: string
  readonly operationId: string
  readonly baseSeq: number
  readonly command: BoardCommand
}

export type ApplyCommandResult =
  | { readonly kind: 'applied'; readonly operation: AppliedOperation }
  | { readonly kind: 'duplicate'; readonly operation: AppliedOperation }
  | {
      readonly kind: 'rejected'
      readonly code: 'target_missing' | 'invalid_command'
      readonly message: string
    }
  | { readonly kind: 'board-not-found' }

export interface CollaborationStore {
  getBoard(boardId: string): Promise<BoardSnapshot | null>
  listOperations(
    boardId: string,
    afterSequence: number,
    limit?: number,
  ): Promise<readonly AppliedOperation[]>
  applyCommand(input: ApplyCommandInput): Promise<ApplyCommandResult>
}

export function commandToEvent(command: BoardCommand): BoardEvent {
  switch (command.type) {
    case 'card.create':
      return {
        type: 'card.created',
        card: {
          id: command.cardId,
          title: command.title,
          laneId: command.laneId,
          assigneeId: null,
          ready: false,
        },
        beforeCardId: command.beforeCardId,
      }
    case 'card.rename':
      return { type: 'card.renamed', cardId: command.cardId, title: command.title }
    case 'card.move':
      return {
        type: 'card.moved',
        cardId: command.cardId,
        laneId: command.laneId,
        beforeCardId: command.beforeCardId,
      }
    case 'card.assign':
      return { type: 'card.assigned', cardId: command.cardId, assigneeId: command.assigneeId }
    case 'card.set-ready':
      return { type: 'card.readiness-changed', cardId: command.cardId, ready: command.ready }
  }
}

export function applyCommandToBoard(
  board: BoardSnapshot,
  command: BoardCommand,
): { readonly board: BoardSnapshot; readonly event: BoardEvent } {
  const event = commandToEvent(command)
  return { board: applyBoardEvent(board, event), event }
}

export function rejectionFor(error: unknown): Extract<ApplyCommandResult, { kind: 'rejected' }> {
  if (error instanceof BoardTransitionError) {
    return {
      kind: 'rejected',
      code: error.code === 'card_not_found' ? 'target_missing' : 'invalid_command',
      message: error.message,
    }
  }

  throw error
}
