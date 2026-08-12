import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

import WebSocket from 'ws'

import {
  boardSnapshotSchema,
  parseServerMessage,
  protocolVersion,
  type BoardCommand,
  type ServerMessage,
} from '@realtime-collaboration/protocol'

import { evaluatePerformance, summarizeLatencies, throughputPerSecond } from './statistics.js'

const configuration = loadConfiguration(process.env)
const resultDirectory = 'performance-results'
const resultPath = `${resultDirectory}/load-smoke.json`
const errorPath = `${resultDirectory}/load-smoke-error.log`

interface Session {
  readonly actorId: string
  readonly boardId: string
  readonly displayName: string
  readonly cookie: string
}

interface PendingOperation {
  readonly resolve: (result: 'acknowledged' | 'rate_limited') => void
  readonly reject: (error: Error) => void
}

class LoadClient {
  private readonly pending = new Map<string, PendingOperation>()
  private readonly waiters = new Set<{
    readonly sequence: number
    readonly resolve: () => void
    readonly reject: (error: Error) => void
  }>()
  private sequence = 0
  private closed = false
  private snapshotReceived = false
  private readonly snapshotReady: Promise<void>
  private resolveSnapshot: () => void = () => undefined
  private rejectSnapshot: (error: Error) => void = () => undefined

  private constructor(
    private readonly socket: WebSocket,
    private readonly session: Session,
  ) {
    this.snapshotReady = new Promise((resolve, reject) => {
      this.resolveSnapshot = resolve
      this.rejectSnapshot = reject
    })
    socket.on('message', (data, isBinary) => this.receive(data, isBinary))
    socket.on('close', () => this.fail(new Error('WebSocket closed during load scenario')))
    socket.on('error', (error) => this.fail(error))
  }

  public static async connect(baseUrl: URL, origin: string, session: Session): Promise<LoadClient> {
    const socket = new WebSocket(webSocketUrl(baseUrl), {
      headers: { Cookie: session.cookie, Origin: origin },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const client = new LoadClient(socket, session)
    socket.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion,
        boardId: session.boardId,
        clientId: randomUUID(),
        lastSeenSeq: null,
      }),
    )
    try {
      await client.waitForSnapshot()
      return client
    } catch (error) {
      socket.terminate()
      throw error
    }
  }

  public get currentSequence(): number {
    return this.sequence
  }

  public get isOpen(): boolean {
    return !this.closed && this.socket.readyState === WebSocket.OPEN
  }

  public command(
    command: BoardCommand,
  ): Promise<{ readonly outcome: string; readonly latencyMs: number }> {
    if (!this.isOpen) {
      return Promise.reject(new Error('Cannot send a command through a closed WebSocket'))
    }

    const operationId = randomUUID()
    const startedAt = performance.now()
    const outcome = new Promise<'acknowledged' | 'rate_limited'>((resolve, reject) => {
      this.pending.set(operationId, { resolve, reject })
    })
    this.socket.send(
      JSON.stringify({
        type: 'command',
        protocolVersion,
        boardId: this.session.boardId,
        operationId,
        baseSeq: this.sequence,
        command,
      }),
    )
    return withTimeout(outcome, 10_000, `operation ${operationId}`).then((result) => ({
      outcome: result,
      latencyMs: performance.now() - startedAt,
    }))
  }

  public waitForSequence(sequence: number, timeoutMs: number): Promise<void> {
    if (this.sequence >= sequence) {
      return Promise.resolve()
    }

    const promise = new Promise<void>((resolve, reject) => {
      this.waiters.add({ sequence, resolve, reject })
    })
    return withTimeout(promise, timeoutMs, `server sequence ${sequence}`)
  }

  public close(): Promise<void> {
    if (this.closed) {
      return Promise.resolve()
    }

    this.closed = true
    return new Promise((resolve) => {
      this.socket.once('close', resolve)
      this.socket.close(1000, 'Load scenario complete')
    })
  }

  private waitForSnapshot(): Promise<void> {
    return withTimeout(this.snapshotReady, 10_000, 'initial snapshot')
  }

  private receive(data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) {
      this.fail(new Error('Gateway sent a binary WebSocket message'))
      return
    }

    try {
      const message = parseServerMessage(JSON.parse(toBuffer(data).toString('utf8')) as unknown)
      this.apply(message)
    } catch (error) {
      this.fail(asError(error))
    }
  }

  private apply(message: ServerMessage): void {
    switch (message.type) {
      case 'snapshot':
        this.sequence = boardSnapshotSchema.parse(message.board).sequence
        this.snapshotReceived = true
        this.resolveSnapshot()
        this.resolveWaiters()
        return
      case 'operation':
        if (message.operation.serverSeq > this.sequence + 1) {
          this.fail(
            new Error(
              `Observed operation gap from ${this.sequence} to ${message.operation.serverSeq}`,
            ),
          )
          return
        }

        this.sequence = Math.max(this.sequence, message.operation.serverSeq)
        this.resolveWaiters()
        return
      case 'replay':
        if (message.fromSeq > this.sequence) {
          this.fail(new Error(`Observed replay gap from ${this.sequence} to ${message.fromSeq}`))
          return
        }

        this.sequence = Math.max(this.sequence, message.toSeq)
        this.resolveWaiters()
        return
      case 'ack':
        this.pending.get(message.operationId)?.resolve('acknowledged')
        this.pending.delete(message.operationId)
        return
      case 'reject':
        if (message.code === 'rate_limited') {
          this.pending.get(message.operationId)?.resolve('rate_limited')
        } else {
          this.pending
            .get(message.operationId)
            ?.reject(new Error(`Command rejected with ${message.code}: ${message.message}`))
        }
        this.pending.delete(message.operationId)
        return
      case 'ping':
        this.socket.send(JSON.stringify({ type: 'pong', protocolVersion, nonce: message.nonce }))
        return
      case 'presence':
        return
    }
  }

  private resolveWaiters(): void {
    for (const waiter of this.waiters) {
      if (this.sequence >= waiter.sequence) {
        this.waiters.delete(waiter)
        waiter.resolve()
      }
    }
  }

  private fail(error: Error): void {
    const shouldTerminate = !this.closed && this.socket.readyState < WebSocket.CLOSING
    this.closed = true
    if (!this.snapshotReceived) {
      this.rejectSnapshot(error)
    }
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
    for (const waiter of this.waiters) {
      waiter.reject(error)
    }
    this.waiters.clear()
    if (shouldTerminate) {
      this.socket.terminate()
    }
  }
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString()
  await mkdir(resultDirectory, { recursive: true })
  const steadyClients: LoadClient[] = []
  let overloadClient: LoadClient | null = null

  try {
    await waitForReadiness(configuration.baseUrl)
    const baseline = await currentSequence(configuration.baseUrl)
    const sessions = await Promise.all(
      Array.from({ length: configuration.clients }, (_, index) =>
        createSession(configuration.baseUrl, `Load client ${index + 1}`),
      ),
    )
    for (const session of sessions) {
      steadyClients.push(
        await LoadClient.connect(configuration.baseUrl, configuration.origin, session),
      )
    }

    const steadyStarted = performance.now()
    const perClientResults = await Promise.all(
      steadyClients.map(async (client, clientIndex) => {
        const latencies: number[] = []

        for (
          let commandIndex = 0;
          commandIndex < configuration.commandsPerClient;
          commandIndex += 1
        ) {
          const result = await client.command(createCardCommand(clientIndex, commandIndex))

          if (result.outcome !== 'acknowledged') {
            throw new Error('Steady-state command was rate limited')
          }

          latencies.push(result.latencyMs)
        }

        return latencies
      }),
    )
    const steadyDurationMs = performance.now() - steadyStarted
    const latencies = perClientResults.flat()
    const expectedAcknowledgements = configuration.clients * configuration.commandsPerClient
    const targetSequence = baseline + expectedAcknowledgements
    const convergenceStarted = performance.now()
    const convergence = await Promise.allSettled(
      steadyClients.map((client) =>
        client.waitForSequence(targetSequence, configuration.convergenceLimitMs),
      ),
    )
    const convergenceMs = performance.now() - convergenceStarted
    const convergedClients = convergence.filter(({ status }) => status === 'fulfilled').length

    const overloadSession = await createSession(configuration.baseUrl, 'Overload client')
    overloadClient = await LoadClient.connect(
      configuration.baseUrl,
      configuration.origin,
      overloadSession,
    )
    const burstResults = await Promise.all(
      Array.from({ length: configuration.burstCommands }, (_, index) =>
        overloadClient!.command(createCardCommand(configuration.clients, index)),
      ),
    )
    const rateLimitedCommands = burstResults.filter(
      ({ outcome }) => outcome === 'rate_limited',
    ).length
    const connectionStayedOpen = overloadClient.isOpen
    await delay(configuration.recoveryDelayMs)
    const recovery = await overloadClient.command(
      createCardCommand(configuration.clients + 1, configuration.burstCommands),
    )
    const recoveryAcknowledged = recovery.outcome === 'acknowledged'
    const latency = summarizeLatencies(latencies)
    const scenarioEvaluation = evaluatePerformance({
      expectedAcknowledgements,
      acknowledgements: latencies.length,
      p95LatencyMs: latency.p95,
      p95LimitMs: configuration.p95LimitMs,
      convergedClients,
      expectedClients: configuration.clients,
      convergenceMs,
      convergenceLimitMs: configuration.convergenceLimitMs,
      rateLimitedCommands,
      recoveryAcknowledged,
      connectionStayedOpen,
    })
    const metrics = await readText(new URL('/metrics', configuration.baseUrl))
    const metricsEvidence = {
      appliedCommands: metricValue(
        metrics,
        'realtime_collaboration_commands_total',
        'outcome="applied"',
      ),
      rateLimitedCommands: metricValue(
        metrics,
        'realtime_collaboration_commands_total',
        'outcome="rate_limited"',
      ),
    }
    const metricFailures = [
      ...(metricsEvidence.appliedCommands < expectedAcknowledgements
        ? ['Prometheus did not observe every steady-state applied command']
        : []),
      ...(metricsEvidence.rateLimitedCommands < rateLimitedCommands
        ? ['Prometheus did not observe every rate-limited burst command']
        : []),
    ]
    const evaluation = {
      passed: scenarioEvaluation.passed && metricFailures.length === 0,
      failures: [...scenarioEvaluation.failures, ...metricFailures],
    }
    const result = {
      schemaVersion: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      configuration: {
        origin: configuration.origin,
        clients: configuration.clients,
        commandsPerClient: configuration.commandsPerClient,
        burstCommands: configuration.burstCommands,
        p95LimitMs: configuration.p95LimitMs,
        convergenceLimitMs: configuration.convergenceLimitMs,
      },
      steadyState: {
        acknowledgements: latencies.length,
        durationMs: round(steadyDurationMs),
        throughputPerSecond: throughputPerSecond(latencies.length, steadyDurationMs),
        latencyMs: latency,
        targetSequence,
        convergedClients,
        convergenceMs: round(convergenceMs),
      },
      overload: {
        sentCommands: configuration.burstCommands,
        rateLimitedCommands,
        connectionStayedOpen,
        recoveryAcknowledged,
      },
      metricsEvidence,
      evaluation,
    }

    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    await writeStepSummary(result)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

    if (!evaluation.passed) {
      throw new Error(evaluation.failures.join('; '))
    }
  } catch (error) {
    await writeFile(errorPath, `${asError(error).stack ?? asError(error).message}\n`, 'utf8')
    throw error
  } finally {
    await Promise.allSettled([
      ...steadyClients.map((client) => client.close()),
      ...(overloadClient ? [overloadClient.close()] : []),
    ])
  }
}

interface Configuration {
  readonly baseUrl: URL
  readonly origin: string
  readonly clients: number
  readonly commandsPerClient: number
  readonly burstCommands: number
  readonly p95LimitMs: number
  readonly convergenceLimitMs: number
  readonly recoveryDelayMs: number
}

function loadConfiguration(environment: NodeJS.ProcessEnv): Configuration {
  return {
    baseUrl: new URL(environment['LOAD_BASE_URL'] ?? 'http://127.0.0.1:3001'),
    origin: new URL(environment['LOAD_ORIGIN'] ?? 'http://127.0.0.1:5173').origin,
    clients: positiveInteger(environment['LOAD_CLIENTS'], 8),
    commandsPerClient: positiveInteger(environment['LOAD_COMMANDS_PER_CLIENT'], 10),
    burstCommands: positiveInteger(environment['LOAD_BURST_COMMANDS'], 200),
    p95LimitMs: positiveNumber(environment['LOAD_P95_LIMIT_MS'], 1_500),
    convergenceLimitMs: positiveNumber(environment['LOAD_CONVERGENCE_LIMIT_MS'], 5_000),
    recoveryDelayMs: positiveNumber(environment['LOAD_RECOVERY_DELAY_MS'], 2_500),
  }
}

async function createSession(baseUrl: URL, displayName: string): Promise<Session> {
  const response = await fetch(new URL('/api/demo-sessions', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName }),
  })
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  const body: unknown = await response.json()

  if (!response.ok || !cookie || typeof body !== 'object' || body === null) {
    throw new Error(`Session creation failed with HTTP ${response.status}`)
  }

  const record = body as Record<string, unknown>

  if (
    typeof record['actorId'] !== 'string' ||
    typeof record['boardId'] !== 'string' ||
    typeof record['displayName'] !== 'string'
  ) {
    throw new Error('Session response violated the expected shape')
  }

  return {
    actorId: record['actorId'],
    boardId: record['boardId'],
    displayName: record['displayName'],
    cookie,
  }
}

async function currentSequence(baseUrl: URL): Promise<number> {
  const session = await createSession(baseUrl, 'Sequence observer')
  const response = await fetch(new URL(`/api/boards/${session.boardId}`, baseUrl), {
    headers: { Cookie: session.cookie },
  })
  const board: unknown = await response.json()
  return boardSnapshotSchema.parse(board).sequence
}

async function waitForReadiness(baseUrl: URL): Promise<void> {
  const deadline = Date.now() + 20_000

  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/api/ready', baseUrl))

      if (response.ok) {
        return
      }
    } catch {
      // The gateway may still be starting.
    }

    await delay(250)
  }

  throw new Error('Gateway did not become ready within 20 seconds')
}

async function readText(url: URL): Promise<string> {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`GET ${url.pathname} failed with HTTP ${response.status}`)
  }

  return response.text()
}

function createCardCommand(clientIndex: number, commandIndex: number): BoardCommand {
  return {
    type: 'card.create',
    cardId: randomUUID(),
    title: `Load ${clientIndex + 1}-${commandIndex + 1}`,
    laneId: 'planned',
    beforeCardId: null,
  }
}

function webSocketUrl(baseUrl: URL): URL {
  const url = new URL('/ws', baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data)
  }

  return Buffer.from(data)
}

function metricValue(metrics: string, name: string, label: string): number {
  const line = metrics
    .split('\n')
    .find((candidate) => candidate.startsWith(`${name}{`) && candidate.includes(label))
  const value = Number(line?.trim().split(/\s+/u).at(-1))
  return Number.isFinite(value) ? value : 0
}

async function writeStepSummary(result: {
  readonly steadyState: {
    readonly acknowledgements: number
    readonly throughputPerSecond: number
    readonly latencyMs: { readonly p95: number; readonly p99: number }
    readonly convergedClients: number
    readonly convergenceMs: number
  }
  readonly overload: {
    readonly rateLimitedCommands: number
    readonly connectionStayedOpen: boolean
    readonly recoveryAcknowledged: boolean
  }
  readonly evaluation: { readonly passed: boolean; readonly failures: readonly string[] }
}): Promise<void> {
  const summaryPath = process.env['GITHUB_STEP_SUMMARY']

  if (!summaryPath) {
    return
  }

  const lines = [
    '## Realtime load smoke',
    '',
    '| Signal | Result |',
    '| --- | ---: |',
    `| Acknowledgements | ${result.steadyState.acknowledgements} |`,
    `| Throughput | ${result.steadyState.throughputPerSecond} commands/s |`,
    `| p95 / p99 | ${result.steadyState.latencyMs.p95} / ${result.steadyState.latencyMs.p99} ms |`,
    `| Converged clients | ${result.steadyState.convergedClients} |`,
    `| Convergence | ${result.steadyState.convergenceMs} ms |`,
    `| Rate-limited burst commands | ${result.overload.rateLimitedCommands} |`,
    `| Connection stayed open | ${String(result.overload.connectionStayedOpen)} |`,
    `| Recovery acknowledged | ${String(result.overload.recoveryAcknowledged)} |`,
    `| Evaluation | ${result.evaluation.passed ? 'PASS' : 'FAIL'} |`,
    '',
    ...result.evaluation.failures.map((failure) => `- ${failure}`),
    '',
  ]
  await writeFile(summaryPath, lines.join('\n'), { encoding: 'utf8', flag: 'a' })
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${String(value)}`)
  }

  return parsed
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value)

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive number, received ${String(value)}`)
  }

  return parsed
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)
    timeout.unref()
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(asError(error))
      },
    )
  })
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs))
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

await main()
