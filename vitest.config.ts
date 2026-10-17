import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    globalSetup: ['tests/globalSetup.ts'],
    exclude: [...configDefaults.exclude, 'tests/fixtures/**', '.tmp/**'],
    // A temp repo that has lost its .git must fail rather than reach this repository.
    env: { GIT_CEILING_DIRECTORIES: fileURLToPath(new URL('.tmp', import.meta.url)) },
  },
});
