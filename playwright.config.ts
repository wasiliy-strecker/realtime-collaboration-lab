import { defineConfig, devices } from '@playwright/test'

const webUrl = 'http://127.0.0.1:5173'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: webUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @realtime-collaboration/gateway dev',
      url: 'http://127.0.0.1:3001/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        ALLOWED_ORIGINS: webUrl,
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgres://collaboration:collaboration@127.0.0.1:5432/collaboration',
        LOG_LEVEL: 'warn',
        SESSION_SECRET:
          process.env.SESSION_SECRET ?? 'local-e2e-session-secret-with-at-least-32-bytes',
      },
    },
    {
      command: 'pnpm --filter @realtime-collaboration/web dev',
      url: webUrl,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
})
