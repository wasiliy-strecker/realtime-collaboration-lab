import type { FastifyBaseLogger } from 'fastify'
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
  type RegistryContentType,
} from 'prom-client'

export type CommandOutcome =
  'applied' | 'duplicate' | 'rejected' | 'board_not_found' | 'rate_limited' | 'error'

export type ConnectionCloseCause =
  | 'client_closed'
  | 'heartbeat_timeout'
  | 'slow_consumer'
  | 'protocol_violation'
  | 'rate_limited'
  | 'replay_failed'

export type ReplayTrigger = 'join' | 'explicit' | 'live_pump'

export type GatewayObservabilityEvent =
  | {
      readonly type: 'connection.opened'
      readonly actorId: string
    }
  | {
      readonly type: 'connection.closed'
      readonly actorId: string
      readonly boardId: string | null
      readonly clientId: string | null
      readonly cause: ConnectionCloseCause
    }
  | {
      readonly type: 'command.completed'
      readonly boardId: string
      readonly operationId: string
      readonly commandType: string
      readonly outcome: CommandOutcome
      readonly durationMs: number
    }
  | {
      readonly type: 'replay.requested'
      readonly boardId: string
      readonly clientId: string | null
      readonly afterSequence: number
    }
  | {
      readonly type: 'replay.completed'
      readonly boardId: string
      readonly clientId: string | null
      readonly trigger: ReplayTrigger
      readonly batches: number
      readonly operations: number
      readonly durationMs: number
    }
  | {
      readonly type: 'rate_limit.reached'
      readonly boardId: string | null
      readonly clientId: string | null
      readonly messageType: string
    }
  | {
      readonly type: 'notification.failed'
      readonly error: Error
    }

export interface GatewayObserver {
  observe(event: GatewayObservabilityEvent): void
}

export interface GatewayObservability extends GatewayObserver {
  readonly contentType: RegistryContentType
  metrics(): Promise<string>
}

export const noopGatewayObserver: GatewayObserver = {
  observe: () => undefined,
}

export function createPrometheusGatewayObservability(
  logger: FastifyBaseLogger,
): GatewayObservability {
  const registry = new Registry()
  collectDefaultMetrics({ register: registry })

  const activeConnections = new Gauge({
    name: 'realtime_collaboration_active_connections',
    help: 'Current authenticated WebSocket connections',
    registers: [registry],
  })
  const connectionCloses = new Counter({
    name: 'realtime_collaboration_connection_closes_total',
    help: 'WebSocket connections closed by bounded cause',
    labelNames: ['cause'] as const,
    registers: [registry],
  })
  const commands = new Counter({
    name: 'realtime_collaboration_commands_total',
    help: 'Collaboration commands completed by outcome',
    labelNames: ['outcome'] as const,
    registers: [registry],
  })
  const commandDuration = new Histogram({
    name: 'realtime_collaboration_command_duration_seconds',
    help: 'Collaboration command handling duration by outcome',
    labelNames: ['outcome'] as const,
    buckets: [0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  })
  const replayRequests = new Counter({
    name: 'realtime_collaboration_replay_requests_total',
    help: 'Explicit replay requests received from clients',
    registers: [registry],
  })
  const replayBatches = new Counter({
    name: 'realtime_collaboration_replay_batches_total',
    help: 'Replay frames delivered by trigger',
    labelNames: ['trigger'] as const,
    registers: [registry],
  })
  const replayOperations = new Counter({
    name: 'realtime_collaboration_replay_operations_total',
    help: 'Durable operations delivered in replay frames by trigger',
    labelNames: ['trigger'] as const,
    registers: [registry],
  })
  const replayDuration = new Histogram({
    name: 'realtime_collaboration_replay_duration_seconds',
    help: 'Replay query and delivery duration by trigger',
    labelNames: ['trigger'] as const,
    buckets: [0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  })
  const rateLimits = new Counter({
    name: 'realtime_collaboration_rate_limits_total',
    help: 'Messages rejected by the per-connection rate limiter',
    labelNames: ['message_type'] as const,
    registers: [registry],
  })
  const notificationErrors = new Counter({
    name: 'realtime_collaboration_notification_errors_total',
    help: 'PostgreSQL notification listener errors',
    registers: [registry],
  })
  activeConnections.set(0)

  return {
    contentType: registry.contentType,
    metrics: () => registry.metrics(),
    observe: (event) => {
      switch (event.type) {
        case 'connection.opened':
          activeConnections.inc()
          logger.info(logFields(event), 'Collaboration connection opened')
          return
        case 'connection.closed':
          activeConnections.dec()
          connectionCloses.inc({ cause: event.cause })

          if (event.cause === 'client_closed') {
            logger.info(logFields(event), 'Collaboration connection closed')
          } else {
            logger.warn(logFields(event), 'Collaboration connection closed abnormally')
          }
          return
        case 'command.completed':
          commands.inc({ outcome: event.outcome })
          commandDuration.observe(
            { outcome: event.outcome },
            millisecondsToSeconds(event.durationMs),
          )

          if (['rejected', 'board_not_found', 'rate_limited', 'error'].includes(event.outcome)) {
            logger.warn(logFields(event), 'Collaboration command did not apply')
          } else {
            logger.debug(logFields(event), 'Collaboration command completed')
          }
          return
        case 'replay.requested':
          replayRequests.inc()
          logger.info(logFields(event), 'Collaboration replay requested')
          return
        case 'replay.completed':
          replayBatches.inc({ trigger: event.trigger }, event.batches)
          replayOperations.inc({ trigger: event.trigger }, event.operations)
          replayDuration.observe(
            { trigger: event.trigger },
            millisecondsToSeconds(event.durationMs),
          )
          logger.debug(logFields(event), 'Collaboration replay completed')
          return
        case 'rate_limit.reached':
          rateLimits.inc({ message_type: event.messageType })
          logger.warn(logFields(event), 'Collaboration rate limit reached')
          return
        case 'notification.failed':
          notificationErrors.inc()
          logger.error(logFields(event), 'Collaboration notification failed')
      }
    },
  }
}

function logFields(event: GatewayObservabilityEvent): Record<string, unknown> {
  const { type, ...details } = event
  return { event: type, ...details }
}

function millisecondsToSeconds(durationMs: number): number {
  return Math.max(0, durationMs) / 1_000
}
