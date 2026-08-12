export interface LatencySummary {
  readonly count: number
  readonly min: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
  readonly mean: number
}

export interface PerformanceEvaluationInput {
  readonly expectedAcknowledgements: number
  readonly acknowledgements: number
  readonly p95LatencyMs: number
  readonly p95LimitMs: number
  readonly convergedClients: number
  readonly expectedClients: number
  readonly convergenceMs: number
  readonly convergenceLimitMs: number
  readonly rateLimitedCommands: number
  readonly recoveryAcknowledged: boolean
  readonly connectionStayedOpen: boolean
}

export interface PerformanceEvaluation {
  readonly passed: boolean
  readonly failures: readonly string[]
}

export function summarizeLatencies(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) {
    throw new Error('At least one latency sample is required')
  }

  const sorted = samples.map(normalizeDuration).sort((left, right) => left - right)
  const total = sorted.reduce((sum, sample) => sum + sample, 0)

  return {
    count: sorted.length,
    min: round(sorted[0]!),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted.at(-1)!),
    mean: round(total / sorted.length),
  }
}

export function throughputPerSecond(completed: number, durationMs: number): number {
  if (!Number.isSafeInteger(completed) || completed < 0) {
    throw new Error('Completed operation count must be a non-negative integer')
  }

  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('Duration must be greater than zero')
  }

  return round(completed / (durationMs / 1_000))
}

export function evaluatePerformance(input: PerformanceEvaluationInput): PerformanceEvaluation {
  const failures: string[] = []

  if (input.acknowledgements !== input.expectedAcknowledgements) {
    failures.push(
      `Expected ${input.expectedAcknowledgements} acknowledgements, received ${input.acknowledgements}`,
    )
  }

  if (input.p95LatencyMs > input.p95LimitMs) {
    failures.push(`p95 latency ${input.p95LatencyMs} ms exceeded ${input.p95LimitMs} ms`)
  }

  if (input.convergedClients !== input.expectedClients) {
    failures.push(`Only ${input.convergedClients} of ${input.expectedClients} clients converged`)
  }

  if (input.convergenceMs > input.convergenceLimitMs) {
    failures.push(`Convergence ${input.convergenceMs} ms exceeded ${input.convergenceLimitMs} ms`)
  }

  if (input.rateLimitedCommands < 1) {
    failures.push('Overload did not trigger command rate limiting')
  }

  if (!input.connectionStayedOpen) {
    failures.push('Overloaded command connection closed unexpectedly')
  }

  if (!input.recoveryAcknowledged) {
    failures.push('Command was not acknowledged after rate-limit recovery')
  }

  return { passed: failures.length === 0, failures }
}

function percentile(sorted: readonly number[], value: number): number {
  const index = Math.max(0, Math.ceil((value / 100) * sorted.length) - 1)
  return sorted[Math.min(index, sorted.length - 1)]!
}

function normalizeDuration(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error('Latency samples must be finite')
  }

  return Math.max(0, value)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
