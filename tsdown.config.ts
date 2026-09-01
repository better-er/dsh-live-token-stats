import { defineConfig } from 'tsdown'

// 客户端模块表中 shell 共享的平台模块打包时需保持 external 由 loader 的 require 解析。
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

const ID = 'dsh-live-token-stats'

export default defineConfig([
  // 主机半身：src/index.ts 产出 lib/index.js，ESM 且 node 平台。
  {
    name: `${ID}/lib`,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    // 产出 lib/index.js / lib/index.d.ts 非 mjs d.mts 使 main/types 解析无需处理扩展名。
    fixedExtension: false,
    dts: true,
    clean: false,
    // 框架依赖在运行时由 dsh profile 树解析。
    deps: {
      neverBundle: [
        '@deepseek-ai/cordis',
        '@deepseek-ai/schemastery',
        // 仅调用的官方运行时包不打入 bundle profile 树已安装。
        '@deepseek-ai/dsh-client-connection',
        '@deepseek-ai/dsh-host-apiproxy',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-session',
        '@deepseek-ai/dsh-session-projection',
      ],
    },
  },
  // 浏览器半身：src/client/index.ts 产出 lib/client.js，ModuleLoader 工厂。
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    deps: {
      neverBundle: [...CLIENT_EXTERNALS],
      // 不在 loader 模块表中的内容打包进 bundle 此处仅 zod 的 view schema 会内联但客户端未使用。
      alwaysBundle: (id) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
