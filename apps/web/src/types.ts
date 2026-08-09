import type {
  BoardCommand,
  BoardSnapshot,
  ParticipantPresence,
} from '@realtime-collaboration/protocol'
import type { SyncEngine } from '@realtime-collaboration/sync-engine'

export interface DemoSession {
  readonly actorId: string
  readonly displayName: string
  readonly boardId: string
}

export type BoardSyncEngine = SyncEngine<BoardSnapshot, BoardCommand, ParticipantPresence>

export interface PresenceSelection {
  readonly selectedCardId: string | null
  readonly editingCardId: string | null
}
