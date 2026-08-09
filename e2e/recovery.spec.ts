import { randomUUID } from 'node:crypto'

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type WebSocketRoute,
} from '@playwright/test'

import { clientMessageSchema, serverMessageSchema } from '@realtime-collaboration/protocol'

test.describe.configure({ mode: 'serial' })

test.describe('browser recovery', () => {
  test('concurrent writers converge on both accepted cards', async ({ browser }) => {
    const ada = await openParticipant(browser, 'Ada Concurrent')
    const grace = await openParticipant(browser, 'Grace Concurrent')
    const adaCard = uniqueTitle('Ada deployment check')
    const graceCard = uniqueTitle('Grace rollback check')

    try {
      await Promise.all([submitCard(ada.page, adaCard), submitCard(grace.page, graceCard)])

      await Promise.all([
        expectCard(ada.page, adaCard),
        expectCard(ada.page, graceCard),
        expectCard(grace.page, adaCard),
        expectCard(grace.page, graceCard),
      ])

      await expect.poll(() => confirmedSequence(ada.page)).toBe(await confirmedSequence(grace.page))
    } finally {
      await Promise.all([ada.context.close(), grace.context.close()])
    }
  })

  test('an offline optimistic card survives reload and reaches another user', async ({
    browser,
  }) => {
    const authorContext = await browser.newContext()
    let resolveAuthorSocket: (socket: WebSocketRoute) => void = () => undefined
    const authorSocket = new Promise<WebSocketRoute>((resolve) => {
      resolveAuthorSocket = resolve
    })

    await authorContext.routeWebSocket('**/ws', (pageSocket) => {
      resolveAuthorSocket(pageSocket)
      pageSocket.connectToServer()
    })

    const author: Participant = {
      context: authorContext,
      page: await joinParticipant(authorContext, 'Offline Author'),
    }
    const observer = await openParticipant(browser, 'Online Observer')
    const title = uniqueTitle('Queued while offline')

    try {
      await author.context.setOffline(true)
      await (await authorSocket).close({ code: 1012, reason: 'Injected browser outage' })
      await expect(author.page.getByText('Offline · changes queued', { exact: true })).toBeVisible()

      await submitCard(author.page, title)
      await expectCard(author.page, title)
      await expect(observer.page.getByRole('button', { name: title, exact: true })).toHaveCount(0)

      await author.context.setOffline(false)
      await author.page.evaluate(() => window.dispatchEvent(new Event('online')))

      await expect(author.page.getByText('Live', { exact: true })).toBeVisible()
      await expectCard(observer.page, title)

      await author.page.reload()
      await expect(author.page.getByRole('heading', { name: 'Release coordination' })).toBeVisible()
      await expect(author.page.getByText('Live', { exact: true })).toBeVisible()
      await expectCard(author.page, title)
    } finally {
      await Promise.all([author.context.close(), observer.context.close()])
    }
  })

  test('a missing server sequence triggers replay and restores the gap', async ({ browser }) => {
    const observerContext = await browser.newContext()
    let interceptionArmed = false
    let droppedSequence: number | null = null
    let replayRequests = 0

    await observerContext.routeWebSocket('**/ws', (pageSocket) => {
      const serverSocket = pageSocket.connectToServer()

      pageSocket.onMessage((message) => {
        const parsed = clientMessageSchema.safeParse(parseMessage(message))

        if (parsed.success && parsed.data.type === 'replay-request') {
          replayRequests += 1
        }

        serverSocket.send(message)
      })

      serverSocket.onMessage((message) => {
        const parsed = serverMessageSchema.safeParse(parseMessage(message))

        if (
          interceptionArmed &&
          droppedSequence === null &&
          parsed.success &&
          parsed.data.type === 'replay' &&
          parsed.data.operations.length > 0
        ) {
          droppedSequence = parsed.data.operations[0]?.serverSeq ?? null
          return
        }

        pageSocket.send(message)
      })
    })

    const observerPage = await joinParticipant(observerContext, 'Gap Observer')
    const writer = await openParticipant(browser, 'Gap Writer')
    const missingCard = uniqueTitle('Dropped replay frame')
    const followingCard = uniqueTitle('Gap detection trigger')

    try {
      interceptionArmed = true
      await submitCard(writer.page, missingCard)
      await expectCard(writer.page, missingCard)
      await expect.poll(() => droppedSequence).not.toBeNull()
      await expect(
        observerPage.getByRole('button', { name: missingCard, exact: true }),
      ).toHaveCount(0)

      await submitCard(writer.page, followingCard)

      await expect.poll(() => replayRequests).toBeGreaterThan(0)
      await expectCard(observerPage, missingCard)
      await expectCard(observerPage, followingCard)
      await expect(observerPage.getByText('Live', { exact: true })).toBeVisible()
    } finally {
      await Promise.all([observerContext.close(), writer.context.close()])
    }
  })
})

interface Participant {
  readonly context: BrowserContext
  readonly page: Page
}

async function openParticipant(browser: Browser, displayName: string): Promise<Participant> {
  const context = await browser.newContext()
  return { context, page: await joinParticipant(context, displayName) }
}

async function joinParticipant(context: BrowserContext, displayName: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Your display name' }).fill(displayName)
  await page.getByRole('button', { name: 'Join release room' }).click()
  await expect(page.getByRole('heading', { name: 'Release coordination' })).toBeVisible()
  await expect(page.getByText('Live', { exact: true })).toBeVisible()
  return page
}

async function submitCard(page: Page, title: string): Promise<void> {
  await page.getByRole('textbox', { name: 'New card title' }).fill(title)
  await page.getByRole('button', { name: 'Add card' }).click()
}

async function expectCard(page: Page, title: string): Promise<void> {
  await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible()
}

async function confirmedSequence(page: Page): Promise<number> {
  const label = await page.locator('.sequence-label').textContent()
  const sequence = Number(label?.match(/\d+/u)?.[0])

  if (!Number.isSafeInteger(sequence)) {
    throw new Error(`Could not read confirmed sequence from ${String(label)}`)
  }

  return sequence
}

function parseMessage(message: string | Buffer): unknown {
  return JSON.parse(typeof message === 'string' ? message : message.toString('utf8')) as unknown
}

function uniqueTitle(prefix: string): string {
  return `${prefix} ${randomUUID().slice(0, 8)}`
}
