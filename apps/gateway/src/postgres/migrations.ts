import type { Pool, PoolClient } from 'pg'

import { createBoardSnapshot } from '@realtime-collaboration/protocol'

import { demoBoardId } from '../collaboration.js'

const migrations = [
  {
    id: '001_collaboration_log',
    sql: `
      CREATE TABLE collaboration_boards (
        id uuid PRIMARY KEY,
        title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
        snapshot jsonb NOT NULL,
        latest_seq bigint NOT NULL DEFAULT 0 CHECK (latest_seq >= 0),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );

      CREATE TABLE collaboration_operations (
        board_id uuid NOT NULL REFERENCES collaboration_boards(id) ON DELETE CASCADE,
        server_seq bigint NOT NULL CHECK (server_seq > 0),
        operation_id uuid NOT NULL,
        actor_id uuid NOT NULL,
        base_seq bigint NOT NULL CHECK (base_seq >= 0),
        event jsonb NOT NULL,
        applied_at timestamptz NOT NULL,
        PRIMARY KEY (board_id, server_seq),
        UNIQUE (board_id, operation_id)
      );

      CREATE INDEX collaboration_operations_operation_id_idx
        ON collaboration_operations (operation_id);
    `,
  },
] as const

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1)', [1_904_202_608])
    await client.query(`
      CREATE TABLE IF NOT EXISTS collaboration_schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `)

    const applied = await client.query<{ id: string }>(
      'SELECT id FROM collaboration_schema_migrations',
    )
    const appliedIds = new Set(applied.rows.map(({ id }) => id))

    for (const migration of migrations) {
      if (appliedIds.has(migration.id)) {
        continue
      }

      await client.query(migration.sql)
      await client.query('INSERT INTO collaboration_schema_migrations (id) VALUES ($1)', [
        migration.id,
      ])
    }

    await client.query('COMMIT')
  } catch (error) {
    await rollback(client)
    throw error
  } finally {
    client.release()
  }
}

export async function seedDemoBoard(pool: Pool): Promise<void> {
  const board = createBoardSnapshot({ boardId: demoBoardId, title: 'August release' })
  await pool.query(
    `
      INSERT INTO collaboration_boards (id, title, snapshot, latest_seq)
      VALUES ($1, $2, $3::jsonb, $4)
      ON CONFLICT (id) DO NOTHING
    `,
    [board.boardId, board.title, JSON.stringify(board), board.sequence],
  )
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK')
  } catch {
    // The caller releases the failed connection in its finally block.
  }
}
