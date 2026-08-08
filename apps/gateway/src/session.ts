import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

import { z } from 'zod'

const sessionPayloadSchema = z
  .object({
    actorId: z.uuid(),
    displayName: z.string().trim().min(1).max(80),
    expiresAt: z.number().int().positive(),
  })
  .strict()

export const sessionCookieName = 'collaboration_session'

export type SessionIdentity = z.infer<typeof sessionPayloadSchema>

export interface SessionSigner {
  create(displayName: string): { readonly token: string; readonly identity: SessionIdentity }
  verify(token: string): SessionIdentity | null
}

export function createSessionSigner(input: {
  readonly secret: string
  readonly now?: () => number
  readonly createActorId?: () => string
  readonly ttlMs?: number
}): SessionSigner {
  if (Buffer.byteLength(input.secret) < 32) {
    throw new Error('Session secret must contain at least 32 bytes')
  }

  const now = input.now ?? Date.now
  const createActorId = input.createActorId ?? randomUUID
  const ttlMs = input.ttlMs ?? 24 * 60 * 60 * 1_000

  return {
    create(displayName) {
      const identity = sessionPayloadSchema.parse({
        actorId: createActorId(),
        displayName,
        expiresAt: now() + ttlMs,
      })
      const payload = Buffer.from(JSON.stringify(identity)).toString('base64url')
      const signature = sign(payload, input.secret)

      return { token: `${payload}.${signature}`, identity }
    },
    verify(token) {
      if (token.length > 2_048) {
        return null
      }

      const [payload, providedSignature, remainder] = token.split('.')

      if (!payload || !providedSignature || remainder !== undefined) {
        return null
      }

      const expectedSignature = sign(payload, input.secret)

      if (!equalSignatures(providedSignature, expectedSignature)) {
        return null
      }

      try {
        const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
        const identity = sessionPayloadSchema.parse(decoded)
        return identity.expiresAt > now() ? identity : null
      } catch {
        return null
      }
    },
  }
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function equalSignatures(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}
