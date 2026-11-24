import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Run through Electron's Node (`pnpm test`), because better-sqlite3 is compiled for Electron's ABI.
export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    // database suites share tables per server, so run files one at a time
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000
  }
})
