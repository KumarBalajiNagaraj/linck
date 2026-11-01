import { defineConfig } from 'vitest/config';

// The unit tests are plain functions: what the API sends, mapped to what the
// screens read, and the words a refusal is shown in. They need none of the
// build's plugins (Tailwind, the OCR assets), so this config, which vitest
// reads instead of vite.config.ts, leaves them out.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
