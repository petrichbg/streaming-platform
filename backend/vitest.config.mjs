import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/unit/**/*.spec.ts'], exclude: ['dist/**', 'node_modules/**'], environment: 'node' },
});
