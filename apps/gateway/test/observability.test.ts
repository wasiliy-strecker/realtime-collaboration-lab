import type { FastifyBaseLogger } from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { createPrometheusGatewayObservability } from '../src/observability.js'
import { ids } from './helpers.js'

describe('gateway observability', () => {
  it('exports isolated low-cardinality Prometheus metrics for every bounded signal', async () => {
    const logger = fakeLogger()
    const observability = createPrometheusGatewayObservability(logger)

    observability.observe({ type: 'connection.opened', actorId: ids.actor })
    observability.observe({
      type: 'command.completed',
      boardId: ids.board,
      operationId: ids.operation,
      commandType: 'card.create',
      outcome: 'applied',
      durationMs: 25,
    })
    observability.observe({
      type: 'command.completed',
      boardId: ids.board,
      operationId: ids.operationTwo,
      commandType: 'card.rename',
      outcome: 'rejected',
      durationMs: -1,
    })
    observability.observe({
      type: 'replay.requested',
      boardId: ids.board,
      clientId: ids.client,
      afterSequence: 4,
    })
    observability.observe({
      type: 'replay.completed',
      boardId: ids.board,
      clientId: ids.client,
      trigger: 'explicit',
      batches: 2,
      operations: 7,
      durationMs: 50,
    })
    observability.observe({
      type: 'rate_limit.reached',
      boardId: ids.board,
      clientId: ids.client,
      messageType: 'command',
    })
    observability.observe({ type: 'notification.failed', error: new Error('listener failed') })
    observability.observe({
      type: 'connection.closed',
      actorId: ids.actor,
      boardId: ids.board,
      clientId: ids.client,
      cause: 'slow_consumer',
    })

    const metrics = await observability.metrics()

    expect(observability.contentType).toContain('text/plain')
    expect(metrics).toContain('realtime_collaboration_active_connections 0')
    expect(metrics).toContain(
      'realtime_collaboration_connection_closes_total{cause="slow_consumer"} 1',
    )
    expect(metrics).toContain('realtime_collaboration_commands_total{outcome="applied"} 1')
    expect(metrics).toContain('realtime_collaboration_commands_total{outcome="rejected"} 1')
    expect(metrics).toContain('realtime_collaboration_replay_requests_total 1')
    expect(metrics).toContain('realtime_collaboration_replay_batches_total{trigger="explicit"} 2')
    expect(metrics).toContain(
      'realtime_collaboration_replay_operations_total{trigger="explicit"} 7',
    )
    expect(metrics).toContain('realtime_collaboration_rate_limits_total{message_type="command"} 1')
    expect(metrics).toContain('realtime_collaboration_notification_errors_total 1')
    expect(metrics).not.toContain(ids.board)
    expect(metrics).not.toContain(ids.operation)
  })

  it('uses structured log levels without serializing collaboration payloads', () => {
    const logger = fakeLogger()
    const observability = createPrometheusGatewayObservability(logger)

    observability.observe({ type: 'connection.opened', actorId: ids.actor })
    observability.observe({
      type: 'connection.closed',
      actorId: ids.actor,
      boardId: null,
      clientId: null,
      cause: 'client_closed',
    })
    observability.observe({
      type: 'command.completed',
      boardId: ids.board,
      operationId: ids.operation,
      commandType: 'card.create',
      outcome: 'duplicate',
      durationMs: 1,
    })

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'connection.opened', actorId: ids.actor }),
      'Collaboration connection opened',
    )
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'command.completed', outcome: 'duplicate' }),
      'Collaboration command completed',
    )
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('payload')
  })
})

function fakeLogger(): FastifyBaseLogger & {
  readonly debug: ReturnType<typeof vi.fn>
  readonly error: ReturnType<typeof vi.fn>
  readonly info: ReturnType<typeof vi.fn>
  readonly warn: ReturnType<typeof vi.fn>
} {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as FastifyBaseLogger & {
    readonly debug: ReturnType<typeof vi.fn>
    readonly error: ReturnType<typeof vi.fn>
    readonly info: ReturnType<typeof vi.fn>
    readonly warn: ReturnType<typeof vi.fn>
  }
}
