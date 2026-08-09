# React client contract

The release room makes optimistic collaboration visible without making React
the owner of synchronization. UI, transport, and consistency remain separate
and independently testable.

## React boundary

`@realtime-collaboration/react-sync` connects the headless engine to React with
`useSyncExternalStore`. Components render one immutable snapshot containing the
confirmed state, optimistic projection, connection phase, pending intent,
presence, and latest rejection. They never copy board state into a second React
store.

User actions dispatch typed domain commands. The engine immediately derives the
optimistic board from confirmed state plus ordered pending commands. A server
operation removes matching pending intent; a rejection removes it and recomputes
the projection, which makes rollback observable in the same render path.

## Browser boundary

The WebSocket adapter sends `hello` with the last confirmed sequence and routes
only runtime-validated server messages into the engine. It answers protocol
heartbeats, requests replay after gaps, and rejects binary or malformed frames.

Unexpected disconnects return commands to the queued state. Reconnect uses
exponential backoff capped at ten seconds with jitter, while the browser's
`online` event triggers an immediate attempt. The per-tab client ID survives a
reload through `sessionStorage` but remains distinct across tabs.

Confirmed state and pending commands use an actor- and board-scoped
`localStorage` envelope. Protocol schemas validate the complete envelope and
discard corrupt or version-incompatible data. The HTTP-only session token is
never copied into browser storage.

## Interaction boundary

Cards support creation, rename, assignment, readiness, and ordered lane moves.
Drag-and-drop uses pointer and keyboard sensors. Explicit left and right actions
remain available so moving a card never requires a pointer. Selection and edit
presence are throttled and remain ephemeral.

The UI reports offline, connecting, live, and recovering phases, the confirmed
sequence, pending command count, active participants, and rejected changes.

## Executable evidence

Headless tests prove hook subscription cleanup, session parsing, corrupt storage
recovery, every WebSocket message route, ping/pong, offline projection,
acknowledgement, rejection rollback, presence throttling, reconnect resume, and
accessible keyboard alternatives. The Vite production build runs in the same
Node matrix as the server and packages.
