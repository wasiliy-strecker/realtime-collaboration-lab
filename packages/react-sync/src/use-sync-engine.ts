import { useCallback, useSyncExternalStore } from 'react'

import type { SyncEngine, SyncSnapshot } from '@realtime-collaboration/sync-engine'

export function useSyncEngine<State, Command, Presence>(
  engine: SyncEngine<State, Command, Presence>,
): SyncSnapshot<State, Command, Presence> {
  const subscribe = useCallback((listener: () => void) => engine.subscribe(listener), [engine])
  const getSnapshot = useCallback(() => engine.getSnapshot(), [engine])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
