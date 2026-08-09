import { z } from 'zod'

import {
  boardCommandSchema,
  boardSnapshotSchema,
  clientIdSchema,
  operationIdSchema,
  protocolVersion,
  serverSequenceSchema,
  type BoardCommand,
  type BoardSnapshot,
} from '@realtime-collaboration/protocol'
import type { PersistedSyncState, SyncPersistence } from '@realtime-collaboration/sync-engine'

const persistenceEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    confirmedState: boardSnapshotSchema,
    sequence: serverSequenceSchema,
    pending: z.array(
      z
        .object({
          operationId: operationIdSchema,
          baseSeq: serverSequenceSchema,
          command: boardCommandSchema,
          createdAt: z.iso.datetime({ offset: true }),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.confirmedState.sequence !== state.sequence) {
      context.addIssue({
        code: 'custom',
        message: 'Persisted board and sync sequences must match',
        path: ['sequence'],
      })
    }
  })

type BrowserStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>

export function boardPersistenceKey(actorId: string, boardId: string): string {
  return `realtime-collaboration:${protocolVersion}:${actorId}:${boardId}`
}

export function createBoardPersistence(
  storage: BrowserStorage,
  key: string,
): SyncPersistence<BoardSnapshot, BoardCommand> {
  return {
    load() {
      const stored = storage.getItem(key)

      if (!stored) {
        return Promise.resolve(null)
      }

      try {
        const input: unknown = JSON.parse(stored)
        const parsed = persistenceEnvelopeSchema.parse(input)
        return Promise.resolve({
          confirmedState: parsed.confirmedState,
          sequence: parsed.sequence,
          pending: parsed.pending,
        })
      } catch {
        storage.removeItem(key)
        return Promise.resolve(null)
      }
    },
    save(state: PersistedSyncState<BoardSnapshot, BoardCommand>) {
      const validated = persistenceEnvelopeSchema.parse({
        protocolVersion,
        ...state,
      })
      storage.setItem(key, JSON.stringify(validated))
      return Promise.resolve()
    },
  }
}

export function getOrCreateClientId(
  storage: BrowserStorage,
  createId: () => string = () => globalThis.crypto.randomUUID(),
): string {
  const storageKey = 'realtime-collaboration:client-id'
  const existing = clientIdSchema.safeParse(storage.getItem(storageKey))

  if (existing.success) {
    return existing.data
  }

  const clientId = clientIdSchema.parse(createId())
  storage.setItem(storageKey, clientId)
  return clientId
}
