import { describe, expect, it, vi } from 'vitest'

import { createDemoSession, DemoSessionError, loadDemoSession } from '../src/api.js'

const session = {
  actorId: '00000000-0000-4000-8000-000000000201',
  displayName: 'Ada',
  boardId: '00000000-0000-4000-8000-000000000100',
}

describe('demo session API', () => {
  it('restores a valid cookie session and treats 401 as anonymous', async () => {
    const authenticated = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(session)))
    const anonymous = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 401 })),
    )

    await expect(loadDemoSession(authenticated)).resolves.toEqual(session)
    await expect(loadDemoSession(anonymous)).resolves.toBeNull()
    expect(authenticated).toHaveBeenCalledWith(
      '/api/demo-session',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })

  it('creates a named session with JSON credentials', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(session)))

    await expect(createDemoSession('Ada', fetcher)).resolves.toEqual(session)
    expect(fetcher).toHaveBeenCalledWith(
      '/api/demo-sessions',
      expect.objectContaining({ body: JSON.stringify({ displayName: 'Ada' }), method: 'POST' }),
    )
  })

  it('rejects failed and malformed responses at the client boundary', async () => {
    const failed = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 503 })))
    const malformed = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ name: 'Ada' })))

    await expect(createDemoSession('Ada', failed)).rejects.toBeInstanceOf(DemoSessionError)
    await expect(loadDemoSession(malformed)).rejects.toThrow('did not match')
  })
})
