import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    globalSetup: ['tests/globalSetup.ts'],
    exclude: [...configDefaults.exclude, 'tests/fixtures/**', '.tmp/**'],
  },
});
