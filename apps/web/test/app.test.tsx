// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createBoardSnapshot, protocolVersion } from '@realtime-collaboration/protocol'

import { App } from '../src/app.js'
import { FakeBrowserSocket, MemoryStorage } from './helpers.js'

const session = {
  actorId: '00000000-0000-4000-8000-000000000201',
  displayName: 'Ada',
  boardId: '00000000-0000-4000-8000-000000000100',
}
const cardId = '00000000-0000-4000-8000-000000000202'

beforeEach(() => {
  FakeBrowserSocket.reset()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  })
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    value: new MemoryStorage(),
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('App collaboration flow', () => {
  it('restores a session, projects a card immediately, and rolls it back on rejection', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(session)))
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal(
      'WebSocket',
      class extends FakeBrowserSocket {
        public constructor(url: string) {
          super(url)
        }
      },
    )
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(cardId)
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('heading', { name: 'Release coordination' })
    expect(fetcher).toHaveBeenCalledWith('/api/demo-session', expect.any(Object))
    await waitFor(() => expect(FakeBrowserSocket.instances).toHaveLength(1))
    const socket = FakeBrowserSocket.instances[0]!
    act(() => socket.open())
    await act(() => Promise.resolve())
    act(() => {
      socket.message({
        type: 'snapshot',
        protocolVersion,
        board: createBoardSnapshot({ boardId: session.boardId, title: 'August release' }),
        participants: [],
      })
    })

    await user.type(screen.getByRole('textbox', { name: 'New card title' }), 'Run smoke tests')
    await user.click(screen.getByRole('button', { name: 'Add card' }))
    expect(screen.getByRole('button', { name: 'Run smoke tests' })).toBeTruthy()
    const command = socket.jsonMessages().find((message) => message.type === 'command')!

    act(() => {
      socket.message({
        type: 'reject',
        protocolVersion,
        operationId: command.operationId,
        code: 'invalid_command',
        message: 'The card was rejected by policy',
      })
    })

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Run smoke tests' })).toBeNull(),
    )
    expect(screen.getByRole('alert').textContent).toContain('The card was rejected by policy')
  })

  it('creates a new demo session from the anonymous state', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json(session))
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('WebSocket', class extends FakeBrowserSocket {})
    const user = userEvent.setup()
    render(<App />)

    await user.type(await screen.findByRole('textbox', { name: 'Your display name' }), 'Ada')
    await user.click(screen.getByRole('button', { name: 'Join release room' }))

    await screen.findByRole('heading', { name: 'Release coordination' })
    expect(fetcher).toHaveBeenLastCalledWith(
      '/api/demo-sessions',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
