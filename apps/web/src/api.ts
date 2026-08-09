import { z } from 'zod'

import { actorIdSchema, boardIdSchema } from '@realtime-collaboration/protocol'

import type { DemoSession } from './types.js'

const demoSessionSchema = z
  .object({
    actorId: actorIdSchema,
    displayName: z.string().trim().min(1).max(80),
    boardId: boardIdSchema,
  })
  .strict()

export class DemoSessionError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'DemoSessionError'
  }
}

export async function loadDemoSession(
  fetcher: typeof fetch = globalThis.fetch,
): Promise<DemoSession | null> {
  const response = await fetcher('/api/demo-session', {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })

  if (response.status === 401) {
    return null
  }

  return parseSessionResponse(response)
}

export async function createDemoSession(
  displayName: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<DemoSession> {
  const response = await fetcher('/api/demo-sessions', {
    body: JSON.stringify({ displayName }),
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    method: 'POST',
  })

  return parseSessionResponse(response)
}

async function parseSessionResponse(response: Response): Promise<DemoSession> {
  if (!response.ok) {
    throw new DemoSessionError(`Session request failed with status ${response.status}`)
  }

  const body: unknown = await response.json()
  const parsed = demoSessionSchema.safeParse(body)

  if (!parsed.success) {
    throw new DemoSessionError('Session response did not match the collaboration contract')
  }

  return parsed.data
}
