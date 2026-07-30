import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Runs in each test worker before any test file. Signing has no built-in key any more, so
    // the suite has to supply its own rather than inherit one from the machine it runs on.
    setupFiles: ['./tests/setup/signingKeys.ts']
  }
});
