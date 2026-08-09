// RD-GA-HARDEN-01 — Vitest config for the financial-core test suite.
// Node environment (no DOM); resolves the '@/' path alias to the project root so tests
// can import production modules exactly as the app does.

import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: { '@': root },
  },
  test: {
    environment: 'node',
    // RD-STORAGE-01: feature modules may keep their tests beside their code
    // (features/<module>/tests/), which is what the platform-storage module does. The
    // repo-wide tests/ directory is unchanged and still the home for cross-cutting suites.
    include: ['tests/**/*.test.ts', 'features/**/tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    globals: false,
    clearMocks: true,
  },
})
