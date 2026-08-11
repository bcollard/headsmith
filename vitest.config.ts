import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['{src,test}/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // src/core is the part that decides what rules the browser is given and
      // whether a credential is released. It is pure by construction, so
      // there is no excuse for a gap in it; the thresholds are set per-glob
      // rather than globally so UI churn can never quietly lower the bar on
      // the compiler or the vault.
      include: ['src/core/**/*.ts', 'src/background/**/*.ts'],
      thresholds: {
        'src/core/**/*.ts': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
        'src/background/**/*.ts': {
          statements: 80,
          branches: 70,
          functions: 80,
          lines: 80,
        },
      },
    },
  },
});
