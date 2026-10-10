import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 90000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: process.env.RTB_DEMO_URL ?? 'http://localhost:8080' },
});
