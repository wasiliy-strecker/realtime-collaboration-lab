import { describe, expect, it } from 'vitest'

import { BoardTransitionError, createBoardSnapshot } from '@realtime-collaboration/protocol'

import { applyCommandToBoard, commandToEvent, rejectionFor } from '../src/collaboration.js'
import { loadConfig } from '../src/config.js'
import { TokenBucket } from '../src/rate-limit.js'
import { createSessionSigner } from '../src/session.js'
import { ids } from './helpers.js'

describe('gateway configuration', () => {
  it('loads secure local defaults and normalizes allowed origins', () => {
    const config = loadConfig({
      ALLOWED_ORIGINS: 'http://localhost:5173/path,https://example.com',
      GATEWAY_PORT: '0',
    })

    expect(config).toMatchObject({
      nodeEnv: 'development',
      port: 0,
      host: '127.0.0.1',
      logLevel: 'info',
    })
    expect([...config.allowedOrigins]).toEqual(['http://localhost:5173', 'https://example.com'])
  })

  it('rejects the local session secret in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
      'Production requires an explicit session secret',
    )
  })

  it('rejects an invalid origin configuration', () => {
    expect(() => loadConfig({ ALLOWED_ORIGINS: 'not-a-url' })).toThrow()
  })
})

describe('signed demo sessions', () => {
  const secret = 'a-secure-session-secret-with-at-least-32-bytes'

  it('creates and verifies a bounded identity', () => {
    const signer = createSessionSigner({
      secret,
      now: () => 1_000,
      ttlMs: 5_000,
      createActorId: () => ids.actor,
    })
    const session = signer.create('Ada')

    expect(session.identity).toEqual({ actorId: ids.actor, displayName: 'Ada', expiresAt: 6_000 })
    expect(signer.verify(session.token)).toEqual(session.identity)
  })

  it('rejects tampered, malformed, oversized, and expired tokens', () => {
    let now = 1_000
    const signer = createSessionSigner({
      secret,
      now: () => now,
      ttlMs: 1_000,
      createActorId: () => ids.actor,
    })
    const { token } = signer.create('Ada')
    const [payload, signature] = token.split('.')

    expect(signer.verify(`${payload}x.${signature}`)).toBeNull()
    expect(signer.verify('malformed')).toBeNull()
    expect(signer.verify(`${token}.extra`)).toBeNull()
    expect(signer.verify('x'.repeat(2_049))).toBeNull()
    now = 2_001
    expect(signer.verify(token)).toBeNull()
  })

  it('rejects short secrets and invalid identities', () => {
    expect(() => createSessionSigner({ secret: 'short' })).toThrow(
      'Session secret must contain at least 32 bytes',
    )
    const signer = createSessionSigner({ secret, createActorId: () => 'invalid' })
    expect(() => signer.create('')).toThrow()
  })
})

describe('token bucket', () => {
  it('enforces capacity and refills over time without moving its clock backwards', () => {
    const bucket = new TokenBucket(2, 1, 1_000)

    expect(bucket.consume(1_000)).toBe(true)
    expect(bucket.consume(1_000)).toBe(true)
    expect(bucket.consume(1_000)).toBe(false)
    expect(bucket.consume(500)).toBe(false)
    expect(bucket.consume(2_000)).toBe(true)
  })

  it('rejects impossible bucket settings and token amounts', () => {
    expect(() => new TokenBucket(0, 1, 0)).toThrow()
    const bucket = new TokenBucket(2, 1, 0)
    expect(bucket.consume(0, 0)).toBe(false)
    expect(bucket.consume(0, 3)).toBe(false)
  })
})

describe('canonical command mapping', () => {
  it('maps every release card command to its canonical event', () => {
    expect(
      commandToEvent({
        type: 'card.create',
        cardId: ids.card,
        title: 'Release notes',
        laneId: 'planned',
        beforeCardId: null,
      }),
    ).toMatchObject({ type: 'card.created', card: { ready: false, assigneeId: null } })
    expect(
      commandToEvent({ type: 'card.rename', cardId: ids.card, title: 'Public release notes' }),
    ).toEqual({ type: 'card.renamed', cardId: ids.card, title: 'Public release notes' })
    expect(
      commandToEvent({
        type: 'card.move',
        cardId: ids.card,
        laneId: 'ready',
        beforeCardId: null,
      }),
    ).toMatchObject({ type: 'card.moved', laneId: 'ready' })
    expect(
      commandToEvent({ type: 'card.assign', cardId: ids.card, assigneeId: ids.actor }),
    ).toMatchObject({ type: 'card.assigned', assigneeId: ids.actor })
    expect(commandToEvent({ type: 'card.set-ready', cardId: ids.card, ready: true })).toEqual({
      type: 'card.readiness-changed',
      cardId: ids.card,
      ready: true,
    })
  })

  it('applies valid commands and converts transition errors into safe rejections', () => {
    const board = createBoardSnapshot({ boardId: ids.board, title: 'August release' })
    const result = applyCommandToBoard(board, {
      type: 'card.create',
      cardId: ids.card,
      title: 'Release notes',
      laneId: 'planned',
      beforeCardId: null,
    })

    expect(result.board.cards).toHaveLength(1)
    expect(rejectionFor(new BoardTransitionError('card_not_found', 'Missing'))).toMatchObject({
      code: 'target_missing',
    })
    expect(rejectionFor(new BoardTransitionError('invalid_placement', 'Invalid'))).toMatchObject({
      code: 'invalid_command',
    })
    expect(() => rejectionFor(new Error('database failed'))).toThrow('database failed')
  })
})
