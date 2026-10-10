import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.it.ts'],
    testTimeout: 30000,
    hookTimeout: 240000,
    fileParallelism: false,
  },
});
