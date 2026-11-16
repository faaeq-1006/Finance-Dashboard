import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { root: import.meta.dirname, include: ['*.spec.ts'], testTimeout: 30_000, hookTimeout: 30_000, fileParallelism: false, bail: 0 },
});
