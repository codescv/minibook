import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const SYSTEM_CHROME = '/opt/google/chrome/chrome';
const useSystemChrome = existsSync(SYSTEM_CHROME);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: {
          ...(useSystemChrome ? { executablePath: SYSTEM_CHROME } : {}),
          args: ['--disable-lcd-text', '--font-render-hinting=full'],
        },
      },
    },
  ],
  webServer: {
    command: 'pnpm --filter @minibook/ui dev',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
