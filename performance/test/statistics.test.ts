import { describe, expect, it } from 'vitest'

import { evaluatePerformance, summarizeLatencies, throughputPerSecond } from '../src/statistics.js'

describe('performance statistics', () => {
  it('summarizes latency with nearest-rank percentiles', () => {
    const samples = Array.from({ length: 100 }, (_, index) => 100 - index)

    expect(summarizeLatencies(samples)).toEqual({
      count: 100,
      min: 1,
      p50: 50,
      p95: 95,
      p99: 99,
      max: 100,
      mean: 50.5,
    })
    expect(summarizeLatencies([-5, 1.234])).toMatchObject({ min: 0, max: 1.23 })
    expect(() => summarizeLatencies([])).toThrow('At least one latency sample')
    expect(() => summarizeLatencies([Number.NaN])).toThrow('must be finite')
  })

  it('calculates rounded throughput and validates its inputs', () => {
    expect(throughputPerSecond(80, 2_500)).toBe(32)
    expect(throughputPerSecond(1, 3_000)).toBe(0.33)
    expect(() => throughputPerSecond(-1, 1_000)).toThrow('non-negative integer')
    expect(() => throughputPerSecond(1, 0)).toThrow('greater than zero')
  })

  it('accepts a complete run and reports every failed invariant', () => {
    const passing = evaluatePerformance({
      expectedAcknowledgements: 80,
      acknowledgements: 80,
      p95LatencyMs: 300,
      p95LimitMs: 1_500,
      convergedClients: 8,
      expectedClients: 8,
      convergenceMs: 200,
      convergenceLimitMs: 5_000,
      rateLimitedCommands: 120,
      recoveryAcknowledged: true,
      connectionStayedOpen: true,
    })
    const failing = evaluatePerformance({
      expectedAcknowledgements: 80,
      acknowledgements: 79,
      p95LatencyMs: 1_501,
      p95LimitMs: 1_500,
      convergedClients: 7,
      expectedClients: 8,
      convergenceMs: 5_001,
      convergenceLimitMs: 5_000,
      rateLimitedCommands: 0,
      recoveryAcknowledged: false,
      connectionStayedOpen: false,
    })

    expect(passing).toEqual({ passed: true, failures: [] })
    expect(failing.passed).toBe(false)
    expect(failing.failures).toHaveLength(7)
  })
})
