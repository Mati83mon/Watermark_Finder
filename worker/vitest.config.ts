import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@wf/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    server: {
      deps: {
        // `node:sqlite` is newer than this Vite's builtin list, so it must be
        // externalised explicitly or the loader tries to resolve it from disk.
        external: [/^node:sqlite$/],
      },
    },
  },
});
