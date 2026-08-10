import { Pool } from 'pg'

import { buildGateway } from './app.js'
import { loadConfig } from './config.js'
import { seedDemoBoard, runMigrations } from './postgres/migrations.js'
import { PostgresCollaborationNotifier } from './postgres/notifier.js'
import { PostgresCollaborationStore } from './postgres/store.js'

const config = loadConfig(process.env)
const pool = new Pool({ connectionString: config.databaseUrl, max: 20 })

await runMigrations(pool)
await seedDemoBoard(pool)

const app = await buildGateway({
  store: new PostgresCollaborationStore(pool),
  notifier: new PostgresCollaborationNotifier(pool),
  sessionSecret: config.sessionSecret,
  allowedOrigins: config.allowedOrigins,
  readinessCheck: async () => {
    await pool.query('SELECT 1')
  },
  secureCookies: config.nodeEnv === 'production',
  logger: { level: config.logLevel },
})

let stopping = false

async function stop(signal: string): Promise<void> {
  if (stopping) {
    return
  }

  stopping = true
  app.log.info({ signal }, 'Stopping collaboration gateway')
  await app.close()
  await pool.end()
}

process.once('SIGINT', () => void stop('SIGINT'))
process.once('SIGTERM', () => void stop('SIGTERM'))

try {
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  app.log.error(error)
  await pool.end()
  process.exitCode = 1
}
