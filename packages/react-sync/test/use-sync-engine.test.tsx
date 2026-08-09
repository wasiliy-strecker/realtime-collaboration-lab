// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { SyncEngine, SyncSnapshot } from '@realtime-collaboration/sync-engine'

import { useSyncEngine } from '../src/use-sync-engine.js'

class FakeEngine implements SyncEngine<number, number, string> {
  private readonly listeners = new Set<() => void>()
  private snapshot: SyncSnapshot<number, number, string> = {
    confirmedState: 0,
    projectedState: 0,
    sequence: 0,
    pending: [],
    phase: 'offline',
    presence: [],
    lastRejection: null,
  }
  public subscriptions = 0
  public unsubscriptions = 0

  public connect(): Promise<void> {
    return Promise.resolve()
  }

  public disconnect(): Promise<void> {
    return Promise.resolve()
  }

  public dispatch() {
    return { operationId: 'operation', baseSeq: 0, command: 1 }
  }

  public getSnapshot(): SyncSnapshot<number, number, string> {
    return this.snapshot
  }

  public subscribe(listener: () => void): () => void {
    this.subscriptions += 1
    this.listeners.add(listener)
    return () => {
      this.unsubscriptions += 1
      this.listeners.delete(listener)
    }
  }

  public flush(): Promise<void> {
    return Promise.resolve()
  }

  public update(projectedState: number): void {
    this.snapshot = { ...this.snapshot, projectedState }
    for (const listener of this.listeners) {
      listener()
    }
  }
}

describe('useSyncEngine', () => {
  it('reads tear-free snapshots and resubscribes when the engine changes', () => {
    const first = new FakeEngine()
    const second = new FakeEngine()
    const { result, rerender, unmount } = renderHook(
      ({ engine }: { readonly engine: FakeEngine }) => useSyncEngine(engine),
      { initialProps: { engine: first } },
    )

    expect(result.current.projectedState).toBe(0)
    act(() => first.update(4))
    expect(result.current.projectedState).toBe(4)

    rerender({ engine: second })
    expect(first.unsubscriptions).toBe(1)
    act(() => second.update(8))
    expect(result.current.projectedState).toBe(8)

    unmount()
    expect(second.unsubscriptions).toBe(1)
  })
})
