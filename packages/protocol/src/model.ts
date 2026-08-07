import { z } from 'zod'

export const protocolVersion = 1 as const

export const boardIdSchema = z.uuid()
export const cardIdSchema = z.uuid()
export const actorIdSchema = z.uuid()
export const clientIdSchema = z.uuid()
export const operationIdSchema = z.uuid()
export const serverSequenceSchema = z.int().nonnegative()

export const laneIdSchema = z.enum(['planned', 'in-progress', 'ready'])

export const cardTitleSchema = z.string().trim().min(1).max(120)

export const releaseCardSchema = z
  .object({
    id: cardIdSchema,
    title: cardTitleSchema,
    laneId: laneIdSchema,
    assigneeId: actorIdSchema.nullable(),
    ready: z.boolean(),
  })
  .strict()

export const boardSnapshotSchema = z
  .object({
    boardId: boardIdSchema,
    title: z.string().trim().min(1).max(120),
    sequence: serverSequenceSchema,
    cards: z.array(releaseCardSchema),
  })
  .strict()
  .superRefine((board, context) => {
    const seen = new Set<string>()

    for (const [index, card] of board.cards.entries()) {
      if (seen.has(card.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate card id ${card.id}`,
          path: ['cards', index, 'id'],
        })
      }

      seen.add(card.id)
    }
  })

const placementSchema = {
  laneId: laneIdSchema,
  beforeCardId: cardIdSchema.nullable(),
} as const

export const boardCommandSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('card.create'),
      cardId: cardIdSchema,
      title: cardTitleSchema,
      ...placementSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('card.rename'),
      cardId: cardIdSchema,
      title: cardTitleSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('card.move'),
      cardId: cardIdSchema,
      ...placementSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('card.assign'),
      cardId: cardIdSchema,
      assigneeId: actorIdSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('card.set-ready'),
      cardId: cardIdSchema,
      ready: z.boolean(),
    })
    .strict(),
])

export const boardEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('card.created'),
      card: releaseCardSchema,
      beforeCardId: cardIdSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('card.renamed'),
      cardId: cardIdSchema,
      title: cardTitleSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('card.moved'),
      cardId: cardIdSchema,
      ...placementSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('card.assigned'),
      cardId: cardIdSchema,
      assigneeId: actorIdSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('card.readiness-changed'),
      cardId: cardIdSchema,
      ready: z.boolean(),
    })
    .strict(),
])

export const appliedOperationSchema = z
  .object({
    operationId: operationIdSchema,
    serverSeq: serverSequenceSchema.positive(),
    actorId: actorIdSchema,
    appliedAt: z.iso.datetime({ offset: true }),
    event: boardEventSchema,
  })
  .strict()

export type LaneId = z.infer<typeof laneIdSchema>
export type ReleaseCard = z.infer<typeof releaseCardSchema>
export type BoardSnapshot = z.infer<typeof boardSnapshotSchema>
export type BoardCommand = z.infer<typeof boardCommandSchema>
export type BoardEvent = z.infer<typeof boardEventSchema>
export type AppliedOperation = z.infer<typeof appliedOperationSchema>
