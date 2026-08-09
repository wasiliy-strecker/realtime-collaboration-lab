import { useState, type FormEvent } from 'react'

interface SessionFormProps {
  readonly error: string | null
  readonly pending: boolean
  readonly onSubmit: (displayName: string) => Promise<void>
}

export function SessionForm({ error, pending, onSubmit }: SessionFormProps) {
  const [displayName, setDisplayName] = useState('')

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const normalized = displayName.trim()

    if (normalized) {
      void onSubmit(normalized)
    }
  }

  return (
    <main className="welcome-shell">
      <section className="welcome-panel" aria-labelledby="welcome-title">
        <div className="eyebrow">Realtime collaboration lab</div>
        <h1 id="welcome-title">Enter the release room</h1>
        <p>
          Test optimistic changes, ordered recovery and live presence against a real PostgreSQL
          operation log.
        </p>
        <form onSubmit={submit} className="session-form">
          <label htmlFor="display-name">Your display name</label>
          <input
            id="display-name"
            autoComplete="name"
            maxLength={80}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Ada Lovelace"
            required
            value={displayName}
          />
          <button
            className="primary-button"
            disabled={pending || !displayName.trim()}
            type="submit"
          >
            {pending ? 'Creating session…' : 'Join release room'}
          </button>
        </form>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="welcome-proof" aria-label="Implemented reliability properties">
          <span>Optimistic UI</span>
          <span>Gap replay</span>
          <span>Idempotent retries</span>
        </div>
      </section>
    </main>
  )
}
