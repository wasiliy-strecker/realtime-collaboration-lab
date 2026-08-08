import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      exclude: [
        '**/dist/**',
        '**/index.ts',
        '**/*.config.ts',
        'apps/gateway/src/main.ts',
        'apps/gateway/src/postgres/**',
      ],
      include: ['packages/*/src/**/*.ts', 'apps/gateway/src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      thresholds: {
        branches: 85,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
    include: ['apps/**/*.test.ts', 'apps/**/*.test.tsx', 'packages/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/dist/**', '**/node_modules/**'],
  },
})
