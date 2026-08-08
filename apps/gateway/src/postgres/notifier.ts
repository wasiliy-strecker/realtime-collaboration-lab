import type { Notification, Pool, PoolClient } from 'pg'
import { z } from 'zod'

import {
  participantPresenceSchema,
  type ParticipantPresence,
} from '@realtime-collaboration/protocol'

export const operationNotificationChannel = 'collaboration_operations'
export const presenceNotificationChannel = 'collaboration_presence'

const operationNotificationSchema = z
  .object({
    boardId: z.uuid(),
    serverSeq: z.number().int().positive(),
  })
  .strict()

const presenceNotificationSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('upsert'),
      boardId: z.uuid(),
      clientId: z.uuid(),
      participant: participantPresenceSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('remove'),
      boardId: z.uuid(),
      clientId: z.uuid(),
    })
    .strict(),
])

export type PresenceNotification = z.infer<typeof presenceNotificationSchema>

export interface CollaborationNotificationHandlers {
  readonly operationCommitted: (boardId: string, serverSeq: number) => void
  readonly presenceChanged: (notification: PresenceNotification) => void
  readonly listenerError?: (error: Error) => void
}

export interface CollaborationNotifier {
  start(handlers: CollaborationNotificationHandlers): Promise<void>
  publishPresence(notification: PresenceNotification): Promise<void>
  stop(): Promise<void>
}

export class PostgresCollaborationNotifier implements CollaborationNotifier {
  private client: PoolClient | null = null
  private handlers: CollaborationNotificationHandlers | null = null

  public constructor(private readonly pool: Pool) {}

  public async start(handlers: CollaborationNotificationHandlers): Promise<void> {
    if (this.client) {
      return
    }

    const client = await this.pool.connect()
    client.on('notification', this.handleNotification)
    client.on('error', this.handleError)

    try {
      await client.query(`LISTEN ${operationNotificationChannel}`)
      await client.query(`LISTEN ${presenceNotificationChannel}`)
      this.client = client
      this.handlers = handlers
    } catch (error) {
      client.off('notification', this.handleNotification)
      client.off('error', this.handleError)
      client.release()
      throw error
    }
  }

  public async publishPresence(notification: PresenceNotification): Promise<void> {
    const parsed = presenceNotificationSchema.parse(notification)
    await this.pool.query('SELECT pg_notify($1, $2)', [
      presenceNotificationChannel,
      JSON.stringify(parsed),
    ])
  }

  public async stop(): Promise<void> {
    const client = this.client
    this.client = null
    this.handlers = null

    if (!client) {
      return
    }

    client.off('notification', this.handleNotification)
    client.off('error', this.handleError)

    try {
      await client.query('UNLISTEN *')
    } finally {
      client.release()
    }
  }

  private readonly handleNotification = (notification: Notification): void => {
    if (!notification.payload || !this.handlers) {
      return
    }

    try {
      const input: unknown = JSON.parse(notification.payload)

      if (notification.channel === operationNotificationChannel) {
        const parsed = operationNotificationSchema.parse(input)
        this.handlers.operationCommitted(parsed.boardId, parsed.serverSeq)
      } else if (notification.channel === presenceNotificationChannel) {
        this.handlers.presenceChanged(presenceNotificationSchema.parse(input))
      }
    } catch (error) {
      this.handlers.listenerError?.(asError(error))
    }
  }

  private readonly handleError = (error: Error): void => {
    this.handlers?.listenerError?.(error)
  }
}

export function presenceUpsert(input: {
  readonly boardId: string
  readonly clientId: string
  readonly participant: ParticipantPresence
}): PresenceNotification {
  return { action: 'upsert', ...input }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Invalid PostgreSQL notification')
}
