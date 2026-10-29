import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // These flows own native process trees; keep parallel startup bounded.
    maxWorkers: 2,
  },
});
