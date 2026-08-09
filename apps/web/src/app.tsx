import { useEffect, useMemo, useState } from 'react'

import { useSyncEngine } from '@realtime-collaboration/react-sync'

import { createDemoSession, loadDemoSession } from './api.js'
import { NewCardForm, ReleaseBoard } from './board.js'
import { BoardCollaborationClient } from './client.js'
import { SessionForm } from './session-form.js'
import { collaborationWebSocketUrl } from './transport.js'
import type { DemoSession } from './types.js'

type SessionState =
  | { readonly status: 'loading' }
  | { readonly status: 'anonymous'; readonly error: string | null }
  | { readonly status: 'authenticated'; readonly session: DemoSession }

export function App() {
  const [sessionState, setSessionState] = useState<SessionState>({ status: 'loading' })
  const [creatingSession, setCreatingSession] = useState(false)

  useEffect(() => {
    let active = true

    void loadDemoSession()
      .then((session) => {
        if (!active) {
          return
        }

        setSessionState(
          session ? { status: 'authenticated', session } : { status: 'anonymous', error: null },
        )
      })
      .catch(() => {
        if (active) {
          setSessionState({
            status: 'anonymous',
            error: 'The collaboration gateway is not available. Start it and try again.',
          })
        }
      })

    return () => {
      active = false
    }
  }, [])

  async function join(displayName: string): Promise<void> {
    setCreatingSession(true)

    try {
      const session = await createDemoSession(displayName)
      setSessionState({ status: 'authenticated', session })
    } catch {
      setSessionState({
        status: 'anonymous',
        error: 'The session could not be created. Check the gateway and retry.',
      })
    } finally {
      setCreatingSession(false)
    }
  }

  if (sessionState.status === 'loading') {
    return (
      <main className="loading-shell" aria-live="polite">
        <div className="loading-mark" aria-hidden="true" />
        <p>Restoring collaboration session…</p>
      </main>
    )
  }

  if (sessionState.status === 'anonymous') {
    return <SessionForm error={sessionState.error} pending={creatingSession} onSubmit={join} />
  }

  return <ReleaseRoom session={sessionState.session} />
}

function ReleaseRoom({ session }: { readonly session: DemoSession }) {
  const client = useMemo(
    () =>
      new BoardCollaborationClient({
        session,
        localStorage: window.localStorage,
        sessionStorage: window.sessionStorage,
        webSocketUrl: collaborationWebSocketUrl(window.location),
      }),
    [session],
  )
  const snapshot = useSyncEngine(client.engine)

  useEffect(() => {
    client.start()
    return () => {
      void client.stop()
    }
  }, [client])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            R
          </div>
          <div>
            <span className="eyebrow">Realtime collaboration lab</span>
            <strong>{snapshot.projectedState.title}</strong>
          </div>
        </div>
        <div className="header-status">
          <ParticipantStack participants={snapshot.presence} currentName={session.displayName} />
          <ConnectionBadge phase={snapshot.phase} pending={snapshot.pending.length} />
        </div>
      </header>

      <main className="workspace">
        <section className="workspace-heading">
          <div>
            <span className="sequence-label">Confirmed sequence {snapshot.sequence}</span>
            <h1>Release coordination</h1>
            <p>
              Every local intent is projected immediately, then reconciled against the server log.
            </p>
          </div>
          <NewCardForm onCommand={(command) => client.dispatch(command)} />
        </section>

        {snapshot.lastRejection ? (
          <div className="rejection-banner" role="alert">
            <strong>Change rolled back</strong>
            <span>{snapshot.lastRejection.message}</span>
          </div>
        ) : null}

        <ReleaseBoard
          board={snapshot.projectedState}
          participants={snapshot.presence}
          session={session}
          onCommand={(command) => client.dispatch(command)}
          onPresence={(presence) => client.updatePresence(presence)}
        />
      </main>
    </div>
  )
}

function ConnectionBadge({
  phase,
  pending,
}: {
  readonly phase: 'offline' | 'connecting' | 'live' | 'recovering'
  readonly pending: number
}) {
  const labels = {
    offline: 'Offline · changes queued',
    connecting: 'Connecting',
    live: 'Live',
    recovering: 'Recovering gap',
  } as const

  return (
    <div className={`connection-badge connection-${phase}`} aria-live="polite">
      <span aria-hidden="true" />
      {labels[phase]}
      {pending > 0 ? <em>{pending}</em> : null}
    </div>
  )
}

function ParticipantStack({
  participants,
  currentName,
}: {
  readonly participants: readonly { readonly actorId: string; readonly displayName: string }[]
  readonly currentName: string
}) {
  const visible = participants.slice(0, 4)

  return (
    <div className="participant-stack" aria-label={`${participants.length} live participants`}>
      {visible.map((participant) => (
        <span key={participant.actorId} title={participant.displayName}>
          {initials(participant.displayName)}
        </span>
      ))}
      {participants.length === 0 ? <span title={currentName}>{initials(currentName)}</span> : null}
      {participants.length > visible.length ? (
        <span>+{participants.length - visible.length}</span>
      ) : null}
    </div>
  )
}

function initials(displayName: string): string {
  return displayName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}
