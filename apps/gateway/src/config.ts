import { z } from 'zod'

const localSessionSecret = 'local-only-collaboration-session-secret-change-me'

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z
      .url()
      .default('postgres://collaboration:collaboration-local-only@127.0.0.1:5432/collaboration'),
    GATEWAY_HOST: z.string().min(1).default('127.0.0.1'),
    GATEWAY_PORT: z.coerce.number().int().min(0).max(65_535).default(3001),
    SESSION_SECRET: z.string().min(32).default(localSessionSecret),
    ALLOWED_ORIGINS: z.string().default('http://127.0.0.1:5173,http://localhost:5173'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((environment, context) => {
    if (
      environment.NODE_ENV === 'production' &&
      environment.SESSION_SECRET === localSessionSecret
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Production requires an explicit session secret',
        path: ['SESSION_SECRET'],
      })
    }
  })

export interface GatewayConfig {
  readonly nodeEnv: 'development' | 'test' | 'production'
  readonly databaseUrl: string
  readonly host: string
  readonly port: number
  readonly sessionSecret: string
  readonly allowedOrigins: ReadonlySet<string>
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'
}

export function loadConfig(environment: NodeJS.ProcessEnv): GatewayConfig {
  const parsed = environmentSchema.parse(environment)
  const allowedOrigins = new Set(
    parsed.ALLOWED_ORIGINS.split(',').map((origin) => new URL(origin.trim()).origin),
  )

  if (allowedOrigins.size === 0) {
    throw new Error('At least one allowed origin is required')
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    databaseUrl: parsed.DATABASE_URL,
    host: parsed.GATEWAY_HOST,
    port: parsed.GATEWAY_PORT,
    sessionSecret: parsed.SESSION_SECRET,
    allowedOrigins,
    logLevel: parsed.LOG_LEVEL,
  }
}
