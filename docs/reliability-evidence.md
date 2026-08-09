# Browser reliability evidence

The Playwright suite exercises recovery through the shipped React interface,
Fastify gateway, WebSocket protocol, and PostgreSQL 17 operation log. Each user
runs in an isolated browser context with independent cookies and browser
storage. The suite is serial and uses unique card titles, so one scenario cannot
mistake another scenario's data for its own result.

## Failure matrix

| Scenario           | Injected condition                                                                                            | Observable proof                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Concurrent writers | Two isolated users submit different commands from the same visible board state                                | Both accepted cards become visible to both users and both clients reach the same confirmed sequence                                              |
| Offline queue      | Chromium disables one user's network and Playwright severs that user's active socket before a card is created | The card appears optimistically, remains absent for the online observer, then reaches both users after reconnect and remains after a page reload |
| Sequence gap       | Playwright drops the first non-empty replay frame for one observer, then allows the next frame through        | The observer emits a protocol `replay-request`, receives the missing durable range, shows both cards, and returns to `Live`                      |

The gap scenario proxies the real WebSocket connection. It filters one
server-to-browser frame instead of replacing the gateway with a mock. Client
messages, later server messages, authentication, database writes, and replay
queries continue through the production code path.

## CI execution

`pnpm test:e2e` builds the reusable packages before Playwright starts the real
gateway and Vite application. The dedicated `Chromium failure scenarios` job
provisions PostgreSQL 17 and installs the pinned Chromium revision. Tests use
one worker with no retries, so a green result is not produced by rerunning a
flaky failure injection.

On failure, CI retains the Playwright HTML report, trace, screenshot, and video
for seven days. These artifacts show browser actions, network traffic, console
output, and the rendered state at the failure boundary.

## Honest limits

These scenarios prove convergence for the modeled release-board operations and
the specific browser failures above. They do not claim exactly-once network
delivery, Byzantine fault tolerance, multi-region database availability, or
CRDT semantics. Broader load, long-running soak, process-crash, and multi-gateway
tests remain separate concerns rather than inferred guarantees.
