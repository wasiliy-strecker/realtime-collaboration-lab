import type {
  AppliedOperation,
  BoardCommand,
  BoardEvent,
  BoardSnapshot,
  LaneId,
  ReleaseCard,
} from './model.js'
import { boardSnapshotSchema } from './model.js'

export type BoardTransitionErrorCode =
  'card_already_exists' | 'card_not_found' | 'invalid_placement' | 'sequence_gap'

export class BoardTransitionError extends Error {
  public constructor(
    public readonly code: BoardTransitionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BoardTransitionError'
  }
}

export function createBoardSnapshot(input: {
  boardId: string
  title: string
  cards?: readonly ReleaseCard[]
}): BoardSnapshot {
  return boardSnapshotSchema.parse({
    boardId: input.boardId,
    title: input.title,
    sequence: 0,
    cards: input.cards ? input.cards.map((card) => ({ ...card })) : [],
  })
}

export function applyBoardEvent(board: BoardSnapshot, event: BoardEvent): BoardSnapshot {
  switch (event.type) {
    case 'card.created':
      return createCard(board, event.card, event.beforeCardId)
    case 'card.renamed':
      return updateCard(board, event.cardId, (card) => ({ ...card, title: event.title }))
    case 'card.moved':
      return moveCard(board, event.cardId, event.laneId, event.beforeCardId)
    case 'card.assigned':
      return updateCard(board, event.cardId, (card) => ({
        ...card,
        assigneeId: event.assigneeId,
      }))
    case 'card.readiness-changed':
      return updateCard(board, event.cardId, (card) => ({ ...card, ready: event.ready }))
  }
}

export function applyBoardOperation(
  board: BoardSnapshot,
  operation: AppliedOperation,
): BoardSnapshot {
  const expectedSequence = board.sequence + 1

  if (operation.serverSeq !== expectedSequence) {
    throw new BoardTransitionError(
      'sequence_gap',
      `Expected server sequence ${expectedSequence}, received ${operation.serverSeq}`,
    )
  }

  return {
    ...applyBoardEvent(board, operation.event),
    sequence: operation.serverSeq,
  }
}

export function projectBoardCommand(board: BoardSnapshot, command: BoardCommand): BoardSnapshot {
  switch (command.type) {
    case 'card.create':
      return applyBoardEvent(board, {
        type: 'card.created',
        card: {
          id: command.cardId,
          title: command.title,
          laneId: command.laneId,
          assigneeId: null,
          ready: false,
        },
        beforeCardId: command.beforeCardId,
      })
    case 'card.rename':
      return applyBoardEvent(board, {
        type: 'card.renamed',
        cardId: command.cardId,
        title: command.title,
      })
    case 'card.move':
      return applyBoardEvent(board, {
        type: 'card.moved',
        cardId: command.cardId,
        laneId: command.laneId,
        beforeCardId: command.beforeCardId,
      })
    case 'card.assign':
      return applyBoardEvent(board, {
        type: 'card.assigned',
        cardId: command.cardId,
        assigneeId: command.assigneeId,
      })
    case 'card.set-ready':
      return applyBoardEvent(board, {
        type: 'card.readiness-changed',
        cardId: command.cardId,
        ready: command.ready,
      })
  }
}

function createCard(
  board: BoardSnapshot,
  card: ReleaseCard,
  beforeCardId: string | null,
): BoardSnapshot {
  if (board.cards.some((candidate) => candidate.id === card.id)) {
    throw new BoardTransitionError('card_already_exists', `Card ${card.id} already exists`)
  }

  return {
    ...board,
    cards: insertIntoLane(board.cards, { ...card }, card.laneId, beforeCardId),
  }
}

function updateCard(
  board: BoardSnapshot,
  cardId: string,
  update: (card: ReleaseCard) => ReleaseCard,
): BoardSnapshot {
  let found = false
  const cards = board.cards.map((card) => {
    if (card.id !== cardId) {
      return card
    }

    found = true
    return update(card)
  })

  if (!found) {
    throw new BoardTransitionError('card_not_found', `Card ${cardId} does not exist`)
  }

  return { ...board, cards }
}

function moveCard(
  board: BoardSnapshot,
  cardId: string,
  laneId: LaneId,
  beforeCardId: string | null,
): BoardSnapshot {
  const card = board.cards.find((candidate) => candidate.id === cardId)

  if (!card) {
    throw new BoardTransitionError('card_not_found', `Card ${cardId} does not exist`)
  }

  if (beforeCardId === cardId) {
    throw new BoardTransitionError('invalid_placement', 'A card cannot be placed before itself')
  }

  const remainingCards = board.cards.filter((candidate) => candidate.id !== cardId)

  return {
    ...board,
    cards: insertIntoLane(remainingCards, { ...card, laneId }, laneId, beforeCardId),
  }
}

function insertIntoLane(
  cards: readonly ReleaseCard[],
  card: ReleaseCard,
  laneId: LaneId,
  beforeCardId: string | null,
): ReleaseCard[] {
  const result = [...cards]

  if (beforeCardId === null) {
    const lastLaneIndex = result.findLastIndex((candidate) => candidate.laneId === laneId)
    result.splice(lastLaneIndex + 1, 0, card)
    return result
  }

  const targetIndex = result.findIndex((candidate) => candidate.id === beforeCardId)

  if (targetIndex === -1 || result[targetIndex]?.laneId !== laneId) {
    throw new BoardTransitionError(
      'invalid_placement',
      `Target card ${beforeCardId} is not in lane ${laneId}`,
    )
  }

  result.splice(targetIndex, 0, card)
  return result
}
