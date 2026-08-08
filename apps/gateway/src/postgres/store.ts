import type { Pool, PoolClient } from 'pg'

import {
  appliedOperationSchema,
  boardSnapshotSchema,
  type AppliedOperation,
  type BoardSnapshot,
} from '@realtime-collaboration/protocol'

import {
  applyCommandToBoard,
  rejectionFor,
  type ApplyCommandInput,
  type ApplyCommandResult,
  type CollaborationStore,
} from '../collaboration.js'
import { operationNotificationChannel } from './notifier.js'

interface BoardRow {
  readonly snapshot: unknown
  readonly latest_seq: string
}

interface OperationRow {
  readonly operation_id: string
  readonly server_seq: string
  readonly actor_id: string
  readonly event: unknown
  readonly applied_at: Date
}

export class PostgresCollaborationStore implements CollaborationStore {
  public constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async getBoard(boardId: string): Promise<BoardSnapshot | null> {
    const result = await this.pool.query<BoardRow>(
      'SELECT snapshot, latest_seq FROM collaboration_boards WHERE id = $1',
      [boardId],
    )
    const row = result.rows[0]
    return row ? parseBoard(row) : null
  }

  public async listOperations(
    boardId: string,
    afterSequence: number,
    limit = 500,
  ): Promise<readonly AppliedOperation[]> {
    const boundedLimit = Math.max(1, Math.min(500, limit))
    const result = await this.pool.query<OperationRow>(
      `
        SELECT operation_id, server_seq, actor_id, event, applied_at
        FROM collaboration_operations
        WHERE board_id = $1 AND server_seq > $2
        ORDER BY server_seq ASC
        LIMIT $3
      `,
      [boardId, afterSequence, boundedLimit],
    )
    return result.rows.map(parseOperation)
  }

  public async applyCommand(input: ApplyCommandInput): Promise<ApplyCommandResult> {
    const client = await this.pool.connect()

    try {
      await client.query('BEGIN')
      const boardResult = await client.query<BoardRow>(
        `
          SELECT snapshot, latest_seq
          FROM collaboration_boards
          WHERE id = $1
          FOR UPDATE
        `,
        [input.boardId],
      )
      const boardRow = boardResult.rows[0]

      if (!boardRow) {
        await client.query('ROLLBACK')
        return { kind: 'board-not-found' }
      }

      const duplicate = await findOperation(client, input.boardId, input.operationId)

      if (duplicate) {
        await client.query('COMMIT')
        return { kind: 'duplicate', operation: duplicate }
      }

      const board = parseBoard(boardRow)
      let transition: ReturnType<typeof applyCommandToBoard>

      try {
        transition = applyCommandToBoard(board, input.command)
      } catch (error) {
        await client.query('ROLLBACK')
        return rejectionFor(error)
      }

      const serverSeq = parseSequence(boardRow.latest_seq) + 1
      const appliedAt = this.now().toISOString()
      const operation = appliedOperationSchema.parse({
        operationId: input.operationId,
        serverSeq,
        actorId: input.actorId,
        appliedAt,
        event: transition.event,
      })
      const nextBoard = boardSnapshotSchema.parse({
        ...transition.board,
        sequence: serverSeq,
      })

      await client.query(
        `
          INSERT INTO collaboration_operations (
            board_id, server_seq, operation_id, actor_id, base_seq, event, applied_at
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
        `,
        [
          input.boardId,
          serverSeq,
          input.operationId,
          input.actorId,
          input.baseSeq,
          JSON.stringify(operation.event),
          appliedAt,
        ],
      )
      await client.query(
        `
          UPDATE collaboration_boards
          SET snapshot = $2::jsonb,
              latest_seq = $3,
              updated_at = clock_timestamp()
          WHERE id = $1
        `,
        [input.boardId, JSON.stringify(nextBoard), serverSeq],
      )
      await client.query('SELECT pg_notify($1, $2)', [
        operationNotificationChannel,
        JSON.stringify({ boardId: input.boardId, serverSeq }),
      ])
      await client.query('COMMIT')

      return { kind: 'applied', operation }
    } catch (error) {
      await safeRollback(client)
      throw error
    } finally {
      client.release()
    }
  }
}

async function findOperation(
  client: PoolClient,
  boardId: string,
  operationId: string,
): Promise<AppliedOperation | null> {
  const result = await client.query<OperationRow>(
    `
      SELECT operation_id, server_seq, actor_id, event, applied_at
      FROM collaboration_operations
      WHERE board_id = $1 AND operation_id = $2
    `,
    [boardId, operationId],
  )
  const row = result.rows[0]
  return row ? parseOperation(row) : null
}

function parseBoard(row: BoardRow): BoardSnapshot {
  const sequence = parseSequence(row.latest_seq)
  return boardSnapshotSchema.parse({ ...boardSnapshotSchema.parse(row.snapshot), sequence })
}

function parseOperation(row: OperationRow): AppliedOperation {
  return appliedOperationSchema.parse({
    operationId: row.operation_id,
    serverSeq: parseSequence(row.server_seq),
    actorId: row.actor_id,
    event: row.event,
    appliedAt: row.applied_at.toISOString(),
  })
}

function parseSequence(value: string): number {
  const sequence = Number(value)

  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(`Unsafe server sequence ${value}`)
  }

  return sequence
}

async function safeRollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK')
  } catch {
    // The caller releases the failed connection in its finally block.
  }
}
