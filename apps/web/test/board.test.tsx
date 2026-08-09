// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { createBoardSnapshot, type BoardSnapshot } from '@realtime-collaboration/protocol'

import { NewCardForm, ReleaseBoard } from '../src/board.js'

const session = {
  actorId: '00000000-0000-4000-8000-000000000201',
  displayName: 'Ada Lovelace',
  boardId: '00000000-0000-4000-8000-000000000100',
}
const cardId = '00000000-0000-4000-8000-000000000202'

function board(): BoardSnapshot {
  return {
    ...createBoardSnapshot({ boardId: session.boardId, title: 'August release' }),
    cards: [
      {
        id: cardId,
        title: 'Publish release notes',
        laneId: 'planned',
        assigneeId: null,
        ready: false,
      },
    ],
  }
}

describe('ReleaseBoard', () => {
  it('offers accessible command alternatives for moving, editing, assigning, and readiness', async () => {
    const user = userEvent.setup()
    const onCommand = vi.fn()
    const onPresence = vi.fn()
    render(
      <ReleaseBoard
        board={board()}
        participants={[]}
        session={session}
        onCommand={onCommand}
        onPresence={onPresence}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Move Publish release notes right' }))
    expect(onCommand).toHaveBeenLastCalledWith({
      type: 'card.move',
      cardId,
      laneId: 'in-progress',
      beforeCardId: null,
    })

    await user.selectOptions(screen.getByRole('combobox', { name: /Owner for/ }), session.actorId)
    expect(onCommand).toHaveBeenLastCalledWith({
      type: 'card.assign',
      cardId,
      assigneeId: session.actorId,
    })

    await user.click(screen.getByRole('button', { name: 'Mark ready' }))
    expect(onCommand).toHaveBeenLastCalledWith({
      type: 'card.set-ready',
      cardId,
      ready: true,
    })

    await user.click(screen.getByRole('button', { name: 'Rename' }))
    const title = screen.getByRole('textbox', { name: 'Card title' })
    await user.clear(title)
    await user.type(title, 'Publish signed artifacts{Enter}')
    expect(onCommand).toHaveBeenLastCalledWith({
      type: 'card.rename',
      cardId,
      title: 'Publish signed artifacts',
    })
    expect(onPresence).toHaveBeenCalledWith({
      selectedCardId: cardId,
      editingCardId: cardId,
    })
  })

  it('creates a planned card from the compact command form', async () => {
    const user = userEvent.setup()
    const onCommand = vi.fn()
    render(<NewCardForm onCommand={onCommand} />)

    await user.type(screen.getByRole('textbox', { name: 'New card title' }), 'Run smoke tests')
    await user.click(screen.getByRole('button', { name: 'Add card' }))

    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'card.create',
        title: 'Run smoke tests',
        laneId: 'planned',
        beforeCardId: null,
      }),
    )
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'New card title' }).value).toBe('')
  })
})
