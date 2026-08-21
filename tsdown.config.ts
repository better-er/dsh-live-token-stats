import { defineConfig } from 'tsdown'

// Platform modules the shell shares into the client module table; client
// bundles must leave them external (resolved through the loader's require).
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
  // Host half: src/index.ts -> lib/index.js (ESM, node platform).
  {
    name: `${ID}/lib`,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    // Emit lib/index.js / lib/index.d.ts (not .mjs/.d.mts) so `main`/`types`
    // resolve without extension churn.
    fixedExtension: false,
    dts: true,
    clean: false,
    // Framework resolves at runtime from the dsh profile tree.
    deps: {
      neverBundle: [
        '@deepseek-ai/cordis',
        '@deepseek-ai/schemastery',
        // Official runtime packages we only *call* (never bundle): the profile
        // tree already installs them.
        '@deepseek-ai/dsh-client-connection',
        '@deepseek-ai/dsh-host-apiproxy',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-session',
        '@deepseek-ai/dsh-session-projection',
      ],
    },
  },
  // Browser half: src/client/index.ts -> lib/client.js (ModuleLoader factory).
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
      // Anything not in the loader module table inlines into the bundle
      // (here: only zod's view schema would inline, which is not used in client).
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
