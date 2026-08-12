import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // jsdom は各テストが自前で JSDOM を組むので environment は node のままでよい
    include: ['src/**/*.test.js'],
  },
})
