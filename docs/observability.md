# Gateway observability contract

The gateway exposes operational signals without adding identifiers to metric
labels. A dedicated Prometheus registry belongs to each gateway instance, so
multiple instances and test applications cannot overwrite each other's state.
Node.js runtime metrics and the collaboration metrics below are collected on
scrape.

## Metric catalog

| Metric                                             | Labels         | Meaning                                                                                                           |
| -------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `realtime_collaboration_active_connections`        | none           | Authenticated WebSocket connections currently owned by the instance                                               |
| `realtime_collaboration_connection_closes_total`   | `cause`        | Connections closed by client, heartbeat timeout, slow consumer, protocol violation, rate limit, or replay failure |
| `realtime_collaboration_commands_total`            | `outcome`      | Applied, duplicate, rejected, missing-board, rate-limited, or failed commands                                     |
| `realtime_collaboration_command_duration_seconds`  | `outcome`      | End-to-end command handling histogram                                                                             |
| `realtime_collaboration_replay_requests_total`     | none           | Explicit client recovery requests                                                                                 |
| `realtime_collaboration_replay_batches_total`      | `trigger`      | Replay frames emitted during join, explicit recovery, or a live pump                                              |
| `realtime_collaboration_replay_operations_total`   | `trigger`      | Durable operations contained in those frames                                                                      |
| `realtime_collaboration_replay_duration_seconds`   | `trigger`      | Replay query and delivery histogram                                                                               |
| `realtime_collaboration_rate_limits_total`         | `message_type` | Messages stopped by the per-connection token bucket                                                               |
| `realtime_collaboration_notification_errors_total` | none           | Invalid or failed PostgreSQL notification events                                                                  |

`cause`, `outcome`, `trigger`, and `message_type` are bounded enums. Board,
actor, client, card, and operation IDs never become Prometheus labels.

## Operational queries

Command failure ratio over five minutes:

```promql
sum(rate(realtime_collaboration_commands_total{outcome=~"rejected|board_not_found|rate_limited|error"}[5m]))
/
clamp_min(sum(rate(realtime_collaboration_commands_total[5m])), 1)
```

95th-percentile command duration:

```promql
histogram_quantile(
  0.95,
  sum by (le) (rate(realtime_collaboration_command_duration_seconds_bucket[5m]))
)
```

Replay pressure and abnormal connection closes:

```promql
sum(rate(realtime_collaboration_replay_operations_total[5m]))
sum(rate(realtime_collaboration_connection_closes_total{cause!="client_closed"}[5m]))
```

These queries are diagnostic starting points, not universal alert thresholds.
Thresholds require production traffic history and an explicit service-level
objective.

## Structured events

Pino receives the same typed events that update metrics. Normal commands and
completed replay work use `debug`; connection lifecycle and explicit recovery
use `info`; rejected work, rate limits, and abnormal closes use `warn`;
notification failures use `error`.

Logs may contain board, actor, client, and operation IDs for correlation. They
never contain session cookies, tokens, display names, card titles, or command
payloads.

## Health and exposure

`GET /api/health` is process liveness and does not contact dependencies.
`GET /api/ready` performs `SELECT 1` through the production PostgreSQL pool and
returns `503 application/problem+json` without exposing the database error when
the check fails.

`GET /metrics` intentionally has no application-session requirement because it
contains only low-cardinality technical data. A deployment must keep it on an
internal network or protect it at the ingress. This milestone does not add a
Prometheus server, Grafana, OpenTelemetry collector, or deployment-specific
alerts.
