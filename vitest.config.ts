import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [tsconfigPaths()],
  // Official SDK packages ship sourcemaps not published with the npm dist;
  // do not try to load them during transform.
  server: {
    sourcemapIgnoreList: () => true,
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'threads',
    environment: 'node',
    // CI 用 Node 22 跑超长 BPE 对照用例约 7s，会超 vitest 默认 5000ms；
    // 抬高全局超时避免慢机器上误报超时。
    testTimeout: 15_000,
    // Keep the SDK packages inline-transformed instead of node-externalized.
    server: {
      deps: {
        inline: [/@deepseek-ai\//],
      },
    },
  },
})
