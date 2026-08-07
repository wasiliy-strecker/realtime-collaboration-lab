import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  applyBoardEvent,
  applyBoardOperation,
  BoardTransitionError,
  createBoardSnapshot,
  projectBoardCommand,
  type BoardEvent,
  type ReleaseCard,
} from '../src/index.js'

const boardId = '00000000-0000-4000-8000-000000000010'
const actorId = '00000000-0000-4000-8000-000000000011'
const operationId = '00000000-0000-4000-8000-000000000012'

function card(id: number, laneId: ReleaseCard['laneId'] = 'planned'): ReleaseCard {
  return {
    id: `00000000-0000-4000-8000-${id.toString().padStart(12, '0')}`,
    title: `Card ${id}`,
    laneId,
    assigneeId: null,
    ready: false,
  }
}

describe('release board reducer', () => {
  it('validates snapshots created through the public helper', () => {
    expect(() => createBoardSnapshot({ boardId: 'not-a-uuid', title: '' })).toThrow()
  })

  it('applies every supported command without mutating the confirmed board', () => {
    const initial = createBoardSnapshot({ boardId, title: 'August release' })
    const created = projectBoardCommand(initial, {
      type: 'card.create',
      cardId: card(1).id,
      title: 'API freeze',
      laneId: 'planned',
      beforeCardId: null,
    })
    const renamed = projectBoardCommand(created, {
      type: 'card.rename',
      cardId: card(1).id,
      title: 'Public API freeze',
    })
    const moved = projectBoardCommand(renamed, {
      type: 'card.move',
      cardId: card(1).id,
      laneId: 'in-progress',
      beforeCardId: null,
    })
    const assigned = projectBoardCommand(moved, {
      type: 'card.assign',
      cardId: card(1).id,
      assigneeId: actorId,
    })
    const ready = projectBoardCommand(assigned, {
      type: 'card.set-ready',
      cardId: card(1).id,
      ready: true,
    })

    expect(initial.cards).toEqual([])
    expect(ready.cards).toEqual([
      {
        ...card(1, 'in-progress'),
        title: 'Public API freeze',
        assigneeId: actorId,
        ready: true,
      },
    ])
  })

  it('places cards before a target in the requested lane', () => {
    const initial = createBoardSnapshot({
      boardId,
      title: 'August release',
      cards: [card(1), card(2), card(3, 'ready')],
    })
    const created = applyBoardEvent(initial, {
      type: 'card.created',
      card: card(4),
      beforeCardId: card(2).id,
    })
    const moved = applyBoardEvent(created, {
      type: 'card.moved',
      cardId: card(1).id,
      laneId: 'ready',
      beforeCardId: card(3).id,
    })

    expect(created.cards.map(({ id }) => id)).toEqual([
      card(1).id,
      card(4).id,
      card(2).id,
      card(3).id,
    ])
    expect(moved.cards.map(({ id }) => id)).toEqual([
      card(4).id,
      card(2).id,
      card(1).id,
      card(3).id,
    ])
  })

  it.each([
    {
      event: { type: 'card.created', card: card(1), beforeCardId: null } satisfies BoardEvent,
      code: 'card_already_exists',
    },
    {
      event: {
        type: 'card.renamed',
        cardId: card(9).id,
        title: 'Missing',
      } satisfies BoardEvent,
      code: 'card_not_found',
    },
    {
      event: {
        type: 'card.moved',
        cardId: card(1).id,
        laneId: 'planned',
        beforeCardId: card(1).id,
      } satisfies BoardEvent,
      code: 'invalid_placement',
    },
    {
      event: {
        type: 'card.moved',
        cardId: card(1).id,
        laneId: 'ready',
        beforeCardId: card(2).id,
      } satisfies BoardEvent,
      code: 'invalid_placement',
    },
  ])('reports $code for an invalid event', ({ event, code }) => {
    const initial = createBoardSnapshot({
      boardId,
      title: 'August release',
      cards: [card(1), card(2)],
    })

    try {
      applyBoardEvent(initial, event)
      expect.fail('Expected the transition to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(BoardTransitionError)
      expect((error as BoardTransitionError).code).toBe(code)
    }
  })

  it('rejects moving a card that does not exist', () => {
    const initial = createBoardSnapshot({ boardId, title: 'August release' })

    expect(() =>
      applyBoardEvent(initial, {
        type: 'card.moved',
        cardId: card(9).id,
        laneId: 'ready',
        beforeCardId: null,
      }),
    ).toThrowError(expect.objectContaining({ code: 'card_not_found' }))
  })

  it('requires the next contiguous server sequence', () => {
    const initial = createBoardSnapshot({ boardId, title: 'August release' })

    expect(() =>
      applyBoardOperation(initial, {
        operationId,
        serverSeq: 2,
        actorId,
        appliedAt: '2026-08-07T08:00:00+02:00',
        event: { type: 'card.created', card: card(1), beforeCardId: null },
      }),
    ).toThrowError(expect.objectContaining({ code: 'sequence_gap' }))
  })

  it('advances the snapshot sequence for a canonical operation', () => {
    const initial = createBoardSnapshot({ boardId, title: 'August release' })
    const next = applyBoardOperation(initial, {
      operationId,
      serverSeq: 1,
      actorId,
      appliedAt: '2026-08-07T08:00:00+02:00',
      event: { type: 'card.created', card: card(1), beforeCardId: null },
    })

    expect(next.sequence).toBe(1)
    expect(next.cards).toEqual([card(1)])
  })

  it('converges for every identical canonical event order', () => {
    const eventArbitrary = fc.array(fc.boolean(), { maxLength: 50 }).map((values) =>
      values.map((ready, index): BoardEvent => ({
        type: 'card.readiness-changed',
        cardId: card(1).id,
        ready: index === values.length - 1 ? ready : values[index]!,
      })),
    )

    fc.assert(
      fc.property(eventArbitrary, (events) => {
        const initial = createBoardSnapshot({
          boardId,
          title: 'August release',
          cards: [card(1)],
        })
        const left = events.reduce(applyBoardEvent, initial)
        const right = events.reduce(applyBoardEvent, initial)

        expect(left).toEqual(right)
      }),
    )
  })
})
