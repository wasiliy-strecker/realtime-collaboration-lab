# Realtime load and performance evidence

The load smoke uses the shipped session endpoint, cookies, WebSocket protocol,
gateway, and PostgreSQL operation log. It is a reproducible CI regression check,
not a claim about production capacity.

## Scenarios

The steady-state scenario creates eight isolated authenticated clients. Each
client submits ten commands sequentially while all clients write concurrently.
All 80 commands must be acknowledged, p95 acknowledgement latency must remain
at or below 1,500 ms, and every client must observe the same final server
sequence within 5,000 ms.

The overload scenario sends 200 commands at once through one additional
connection. At least one command must receive the typed `rate_limited`
rejection, the socket must remain open, and another command must be acknowledged
after the token bucket refills. This proves controlled load shedding rather
than maximum throughput.

Every received frame passes the production protocol parser. The harness also
fails if an operation or replay jumps over an unobserved server sequence.

## Running the smoke

Start PostgreSQL and the gateway, then run:

```bash
pnpm performance:smoke
```

The defaults can be overridden without editing code:

| Variable                    |                 Default | Meaning                                                                   |
| --------------------------- | ----------------------: | ------------------------------------------------------------------------- |
| `LOAD_BASE_URL`             | `http://127.0.0.1:3001` | Running gateway origin                                                    |
| `LOAD_ORIGIN`               | `http://127.0.0.1:5173` | Allowed browser origin sent during the WebSocket handshake                |
| `LOAD_CLIENTS`              |                     `8` | Concurrent steady-state clients                                           |
| `LOAD_COMMANDS_PER_CLIENT`  |                    `10` | Sequential commands per client                                            |
| `LOAD_BURST_COMMANDS`       |                   `200` | Commands in the overload burst                                            |
| `LOAD_P95_LIMIT_MS`         |                  `1500` | Maximum accepted p95 acknowledgement latency                              |
| `LOAD_CONVERGENCE_LIMIT_MS` |                  `5000` | Maximum time after the final acknowledgements for all clients to catch up |
| `LOAD_RECOVERY_DELAY_MS`    |                  `2500` | Pause before the post-rate-limit command                                  |

`performance-results/load-smoke.json` contains the configuration, timestamps,
throughput, p50/p95/p99/max latency, final sequence, convergence time,
load-shedding result, relevant Prometheus counter values, and the complete
pass/fail evaluation. CI also retains the gateway log and writes a compact job
summary.

## Interpretation limits

GitHub-hosted runners have variable CPU, storage, and network scheduling. The
generous thresholds therefore catch severe regressions and broken recovery;
they are not an SLA, capacity plan, or comparison with another framework.

The smoke uses one gateway process, one PostgreSQL instance, one board, and a
short run. It does not establish multi-region behavior, long-running soak
stability, process-crash recovery, or a maximum safe number of clients. Those
claims require controlled hardware, repeated distributions, and an explicit
production service-level objective.
