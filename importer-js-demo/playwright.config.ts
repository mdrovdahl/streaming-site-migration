import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30 * 60 * 1000, // 30 min — Playground boot + SQL import + file transfer
  expect: { timeout: 25 * 60 * 1000 },
  use: {
    baseURL: 'http://localhost:3000',
    // headed mode so you can watch; flip to false for CI
    headless: false,
  },
  webServer: {
    command: 'npm exec vite -- --host --port 3000',
    port: 3000,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
