import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        statements: 85,
        functions: 85,
        lines: 85,
        branches: 70,
      },
    },
  },
});
