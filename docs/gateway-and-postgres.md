# Gateway and PostgreSQL contract

The Fastify gateway turns the ordered protocol into a durable, multi-instance
service. PostgreSQL is authoritative. Gateway memory and notifications are
coordination aids only.

## Transaction boundary

Each command runs in one transaction that locks its board row. The store then:

1. returns the existing operation for a repeated `operationId`
2. validates the command against the current snapshot
3. assigns the next board-local `serverSeq`
4. appends the canonical event and updates the JSON snapshot
5. emits a transactional PostgreSQL notification

The unique `(board_id, operation_id)` constraint is the idempotency boundary.
The primary key `(board_id, server_seq)` proves gap-free ordering. Concurrent
gateway processes serialize on the board row rather than trusting process-local
locks.

Rejected commands do not create operation rows. `baseSeq` is retained as
diagnostic evidence but does not make a stale client authoritative.

## Notification and replay

Every gateway holds a dedicated `LISTEN` connection. A notification contains
only board ID and sequence, never the complete event. Receiving a hint schedules
a database read after each socket's last delivered sequence.

Notifications can be delayed or lost. Correctness therefore comes from the
operations table. New sockets receive either a snapshot or an ordered replay;
an explicit `replay-request` can restart delivery after any confirmed sequence.

## Connection boundary

`POST /api/demo-sessions` issues a 24-hour HMAC-signed identity in an HTTP-only,
same-site cookie. `GET /api/demo-session` restores its public actor, display
name, and demo board ID without exposing the token. The WebSocket handshake
requires that cookie and an exact allowed origin. Production configuration
refuses the checked-in local secret.

After upgrade, the gateway enforces:

- a 16 KiB message limit and runtime protocol parsing
- exactly one `hello` before board-scoped messages
- a token bucket of 20 messages per second with burst capacity 40
- protocol heartbeats and expiry of stale presence
- a bounded socket buffer with close code `1013` for slow consumers
- serialized message processing per socket

Presence is broadcast through PostgreSQL notifications but remains best effort.
It expires automatically and is never written into board history.

## Executable evidence

Unit tests use deterministic stores, clocks, sockets, and notifiers. PostgreSQL
integration tests run migrations against PostgreSQL 17 and prove idempotent
retry, concurrent writer ordering, rejection without append, notification
delivery, and one operation reaching clients on two gateway instances.

The gateway does not claim exactly-once network delivery. It provides
at-least-once command retry around an idempotent database operation and
server-ordered replay from durable evidence.
