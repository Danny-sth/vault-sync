import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // The protocol harness runs the real sync classes; 'obsidian' only exists
      // inside the app, so tests get a minimal mock (TFile/TFolder/Notice).
      obsidian: path.resolve(__dirname, 'test/mocks/obsidian.ts'),
    },
  },
  test: {
    setupFiles: ['test/setup.ts'],
  },
});
