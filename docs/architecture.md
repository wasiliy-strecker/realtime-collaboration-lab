# Architecture and consistency boundaries

This document defines the implemented collaboration boundaries from React
interaction through PostgreSQL durability. It keeps later implementation
choices aligned with explicit guarantees.

## Ownership

| Component         | Owns                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| React application | presentation, accessible interaction, and connection feedback        |
| Browser adapters  | WebSocket lifecycle, local persistence, reconnect, and presence      |
| Sync engine       | confirmed state, pending intent, optimistic projection, and recovery |
| Runtime protocol  | validated client and server message shapes                           |
| Fastify gateway   | sessions, command validation, backpressure, and socket lifecycle     |
| PostgreSQL        | canonical board snapshot, idempotency, and server operation order    |
| Notifications     | best-effort wakeups only                                             |

The browser never becomes authoritative because it remained connected. The
gateway never treats its process memory or a notification as durable state.

## Write path

Each command carries a client-generated operation ID and the last server
sequence observed by that client. The gateway locks the board row, returns the
stored result for duplicate operation IDs, validates the command against the
current snapshot, appends the canonical operation, advances the sequence, and
updates the snapshot in one database transaction.

The sequence reported by the client is diagnostic context rather than a claim
to authority. Commands that remain valid may be serialized after newer work;
commands whose target no longer exists are rejected explicitly.

## Read and recovery path

A client persists its confirmed snapshot and sequence separately from pending
commands. On reconnect it presents that sequence. The gateway replays later
operations in order, and the client reapplies still-pending intent after every
confirmed change.

React reads one immutable sync snapshot through `useSyncExternalStore`. It does
not mirror confirmed or optimistic board state in component state. The browser
adapter validates persisted envelopes and every server frame before either can
reach the engine.

Gateways use PostgreSQL notifications to notice work committed by peers. A
notification can be delayed, coalesced, or lost. Any observed sequence jump
therefore causes a database query for the missing range.

## Deliberate limits

This is a server-ordered collaboration model, not a CRDT. It does not support
character-level collaborative text editing or offline writes from an
unbounded number of devices. Network delivery is at least once around retries,
while operation application is idempotent within the retained database log.

Presence describes a live observation and expires when heartbeats stop. It is
not written to the board history and is not reconstructed after a process
restart.
