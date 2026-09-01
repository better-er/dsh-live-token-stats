import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [tsconfigPaths()],
  // 官方 SDK 包的 sourcemap 未随 npm 发行包提供，转换阶段不尝试加载。
  server: {
    sourcemapIgnoreList: () => true,
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'threads',
    environment: 'node',
    // CI 用 Node 22 跑超长 BPE 对照用例约 7s，会超 vitest 默认 5000ms；抬高全局超时避免慢机器上误报超时。
    testTimeout: 15_000,
    // 将 SDK 包内联转换而非 node-externalized。
    server: {
      deps: {
        inline: [/@deepseek-ai\//],
      },
    },
  },
})
