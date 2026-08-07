# Protocol and sync engine contract

The collaboration core separates domain messages from connection mechanics.
The protocol package validates untrusted wire input and owns release-board
transitions. The sync engine is generic and knows nothing about WebSockets,
React, or the board model.

## Ordered protocol

Every client command carries a stable `operationId` and the `baseSeq` observed
when the intent was created. A canonical server operation carries the same ID
and one positive `serverSeq`.

The current protocol contains:

- client `hello`, `command`, `presence`, and `pong` messages
- server `snapshot`, `replay`, `operation`, `ack`, `reject`, `presence`, and
  `ping` messages
- commands and events for creating, renaming, moving, assigning, and marking
  release cards ready

All objects are strict. Unknown properties, unsupported protocol versions,
invalid identifiers, backwards replay ranges, mismatched replay endings, and
non-contiguous replay operations fail runtime parsing.

An acknowledgement means the gateway accepted a command. The command remains
pending until its canonical operation arrives, because only that operation
defines confirmed state.

## Headless engine

```ts
const engine = createSyncEngine({
  initialState,
  reduce: applyCanonicalEvent,
  project: applyOptimisticCommand,
  transport,
  persistence,
})

engine.subscribe(render)
engine.dispatch(command)
await engine.connect()
```

`SyncTransport` receives a sink when it opens. A later WebSocket adapter calls
that sink with snapshots, ordered operations, acknowledgements, rejections,
presence, or connection closure. `SyncPersistence` stores only confirmed state,
its sequence, and replayable pending commands.

The observable snapshot contains:

- `confirmedState` from canonical operations
- `projectedState` rebuilt from confirmed state plus pending commands
- pending command delivery and projection status
- `offline`, `connecting`, `live`, or `recovering` connection phase
- current ephemeral presence and the latest command rejection

Persistence writes are serialized. A failed save does not poison later saves,
and an older slow write cannot complete after a newer write.

## Recovery behavior

Operations at or below the confirmed sequence are network duplicates. They are
not applied again, but a matching pending command is cleared. The next
contiguous sequence advances confirmed state.

An operation beyond the next sequence is not applied. The engine enters
`recovering` and asks the transport to replay after the last confirmed
sequence. It returns to `live` only after a contiguous replay reports that it
is caught up.

Rejected commands are removed before remaining pending commands are projected
again. A command that cannot currently be projected remains pending with a
safe projection error instead of disappearing.

This model provides deterministic convergence for clients that receive the
same canonical order. It does not claim commutative operations, CRDT behavior,
or exactly-once network delivery.
