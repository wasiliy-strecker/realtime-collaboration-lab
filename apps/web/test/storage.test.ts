import { describe, expect, it } from 'vitest'

import { createBoardSnapshot, type BoardCommand } from '@realtime-collaboration/protocol'

import { boardPersistenceKey, createBoardPersistence, getOrCreateClientId } from '../src/storage.js'
import { MemoryStorage } from './helpers.js'

const boardId = '00000000-0000-4000-8000-000000000100'
const actorId = '00000000-0000-4000-8000-000000000201'
const clientId = '00000000-0000-4000-8000-000000000202'
const operationId = '00000000-0000-4000-8000-000000000203'

describe('browser sync persistence', () => {
  it('round-trips validated confirmed state and pending intent', async () => {
    const storage = new MemoryStorage()
    const key = boardPersistenceKey(actorId, boardId)
    const persistence = createBoardPersistence(storage, key)
    const command: BoardCommand = {
      type: 'card.create',
      cardId: '00000000-0000-4000-8000-000000000204',
      title: 'Release notes',
      laneId: 'planned',
      beforeCardId: null,
    }
    const state = {
      confirmedState: createBoardSnapshot({ boardId, title: 'August release' }),
      sequence: 0,
      pending: [
        {
          operationId,
          baseSeq: 0,
          command,
          createdAt: '2026-08-09T09:00:00.000+02:00',
        },
      ],
    }

    await persistence.save(state)
    await expect(persistence.load()).resolves.toEqual(state)
    expect(key).toContain(actorId)
  })

  it('removes corrupt or inconsistent persisted data', async () => {
    const storage = new MemoryStorage()
    const key = boardPersistenceKey(actorId, boardId)
    const persistence = createBoardPersistence(storage, key)
    storage.setItem(key, '{broken')
    await expect(persistence.load()).resolves.toBeNull()
    expect(storage.getItem(key)).toBeNull()

    storage.setItem(
      key,
      JSON.stringify({
        protocolVersion: 1,
        confirmedState: createBoardSnapshot({ boardId, title: 'August release' }),
        sequence: 2,
        pending: [],
      }),
    )
    await expect(persistence.load()).resolves.toBeNull()
  })

  it('keeps a valid tab client id and replaces invalid storage', () => {
    const storage = new MemoryStorage()
    expect(getOrCreateClientId(storage, () => clientId)).toBe(clientId)
    expect(getOrCreateClientId(storage, () => operationId)).toBe(clientId)

    storage.setItem('realtime-collaboration:client-id', 'invalid')
    expect(getOrCreateClientId(storage, () => operationId)).toBe(operationId)
  })
})
