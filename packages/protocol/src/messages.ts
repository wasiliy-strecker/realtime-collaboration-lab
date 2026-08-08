import { z } from 'zod'

import {
  actorIdSchema,
  appliedOperationSchema,
  boardCommandSchema,
  boardIdSchema,
  boardSnapshotSchema,
  cardIdSchema,
  clientIdSchema,
  operationIdSchema,
  protocolVersion,
  serverSequenceSchema,
} from './model.js'

export const participantPresenceSchema = z
  .object({
    actorId: actorIdSchema,
    displayName: z.string().trim().min(1).max(80),
    selectedCardId: cardIdSchema.nullable(),
    editingCardId: cardIdSchema.nullable(),
    observedAt: z.iso.datetime({ offset: true }),
  })
  .strict()

export const clientMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('hello'),
      protocolVersion: z.literal(protocolVersion),
      boardId: boardIdSchema,
      clientId: clientIdSchema,
      lastSeenSeq: serverSequenceSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('command'),
      protocolVersion: z.literal(protocolVersion),
      boardId: boardIdSchema,
      operationId: operationIdSchema,
      baseSeq: serverSequenceSchema,
      command: boardCommandSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('presence'),
      protocolVersion: z.literal(protocolVersion),
      boardId: boardIdSchema,
      selectedCardId: cardIdSchema.nullable(),
      editingCardId: cardIdSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('replay-request'),
      protocolVersion: z.literal(protocolVersion),
      boardId: boardIdSchema,
      afterSeq: serverSequenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('pong'),
      protocolVersion: z.literal(protocolVersion),
      nonce: z.string().min(1).max(120),
    })
    .strict(),
])

export const rejectionCodeSchema = z.enum([
  'target_missing',
  'invalid_command',
  'forbidden',
  'rate_limited',
])

export const serverMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('snapshot'),
      protocolVersion: z.literal(protocolVersion),
      board: boardSnapshotSchema,
      participants: z.array(participantPresenceSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal('replay'),
      protocolVersion: z.literal(protocolVersion),
      fromSeq: serverSequenceSchema,
      toSeq: serverSequenceSchema,
      operations: z.array(appliedOperationSchema),
      caughtUp: z.boolean(),
    })
    .strict()
    .superRefine((message, context) => {
      if (message.toSeq < message.fromSeq) {
        context.addIssue({
          code: 'custom',
          message: 'Replay end sequence must not precede its start sequence',
          path: ['toSeq'],
        })
      }

      const expectedToSequence = message.operations.at(-1)?.serverSeq ?? message.fromSeq

      if (message.toSeq !== expectedToSequence) {
        context.addIssue({
          code: 'custom',
          message: 'Replay end sequence must match its final operation',
          path: ['toSeq'],
        })
      }

      for (const [index, operation] of message.operations.entries()) {
        if (operation.serverSeq !== message.fromSeq + index + 1) {
          context.addIssue({
            code: 'custom',
            message: 'Replay operations must be contiguous',
            path: ['operations', index, 'serverSeq'],
          })
        }
      }
    }),
  z
    .object({
      type: z.literal('operation'),
      protocolVersion: z.literal(protocolVersion),
      operation: appliedOperationSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('ack'),
      protocolVersion: z.literal(protocolVersion),
      operationId: operationIdSchema,
      serverSeq: serverSequenceSchema.positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('reject'),
      protocolVersion: z.literal(protocolVersion),
      operationId: operationIdSchema,
      code: rejectionCodeSchema,
      message: z.string().trim().min(1).max(240),
    })
    .strict(),
  z
    .object({
      type: z.literal('presence'),
      protocolVersion: z.literal(protocolVersion),
      participants: z.array(participantPresenceSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal('ping'),
      protocolVersion: z.literal(protocolVersion),
      nonce: z.string().min(1).max(120),
    })
    .strict(),
])

export function parseClientMessage(input: unknown): ClientMessage {
  return clientMessageSchema.parse(input)
}

export function parseServerMessage(input: unknown): ServerMessage {
  return serverMessageSchema.parse(input)
}

export type ParticipantPresence = z.infer<typeof participantPresenceSchema>
export type RejectionCode = z.infer<typeof rejectionCodeSchema>
export type ClientMessage = z.infer<typeof clientMessageSchema>
export type ServerMessage = z.infer<typeof serverMessageSchema>
