/**
 * 导出契约门禁。
 *
 * 存在理由：本仓库 vitest 跑在 `environment: 'node'`，`tests/**` 下没有任何 `.spec.tsx`，
 * 因此 `src/client/*.tsx` 对 `@deepseek-ai/*` 的 import 在测试里**根本不执行**——
 * 「测试全绿」从来不能证明 UI 半身所依赖的宿主导出真实存在。历史上正是这个盲区，
 * 让一个已被宿主删除的定位 hook 一路通过 CI 并在渲染期抛 `is not a function`。
 *
 * 本测试不启动浏览器、不引 jsdom，只做两件事：
 *  1. 静态扫描源码里 `@deepseek-ai/*` 的具名 import，逐个对**本地已安装的那份真包**
 *     断言该导出存在——宿主删导出时这里立即红，而不是等用户看到崩溃。
 *  2. 对构建产物断言：已删的 hook 出现 0 次、迁移后的 CSS 锚点特征存在。
 *
 * 这样「换了新宿主、某个导出没了」会在 CI 暴露成一条可读的失败，而不是线上静默降级。
 *
 * @module dsh-live-token-stats/tests/export-contract
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const CLIENT_BUNDLE = join(ROOT, 'lib/client.js')

/** 只对 DSH 官方包做契约校验，其余依赖不属本门禁职责。 */
const DSH_SCOPE = '@deepseek-ai/'

/** 递归收集 src 下所有 ts/tsx 源文件。 */
function collectSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...collectSources(full))
      continue
    }
    if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

interface NamedImport {
  /** 包名，如 `@deepseek-ai/dsh-client-ui-primitives`。 */
  readonly module: string
  /** 具名导入的标识符列表。 */
  readonly names: readonly string[]
  /** 来源文件，用于失败时定位。 */
  readonly file: string
}

/**
 * 提取源码中所有 `@deepseek-ai/*` 的**值**具名导入。
 *
 * 纯类型导入（`import type { ... }`）与行内 `type` 修饰符一律剔除：类型面在构建期已由
 * `tsc -b` 校验，且其导出位于 `.d.ts`，与本门禁要防的「运行时缺导出」不是同一件事。
 */
function collectNamedImports(files: readonly string[]): NamedImport[] {
  const result: NamedImport[] = []
  for (const file of files) {
    const code = readFileSync(file, 'utf8')
    const re = /import\s+(type\s+)?\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g
    for (const match of code.matchAll(re)) {
      const isTypeOnly = match[1] !== undefined
      if (isTypeOnly) continue
      const moduleName = match[3]
      if (!moduleName.startsWith(DSH_SCOPE)) continue
      const names = match[2]
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '')
        // 行内 type 修饰符：`type Foo`，仅类型，跳过。
        .filter((part) => !/^type\s/.test(part))
        // 别名：`Foo as Bar` 取原始导出名 Foo。
        .map((part) => part.split(/\s+as\s+/)[0].trim())
      if (names.length > 0) result.push({ module: moduleName, names, file })
    }
  }
  return result
}

/** 读取某包在本地 node_modules 中的已安装版本。 */
function installedVersion(moduleName: string): string | undefined {
  const manifestPath = join(ROOT, 'node_modules', moduleName, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  return JSON.parse(readFileSync(manifestPath, 'utf8')).version
}

/**
 * 解析一个包运行时真正具名的导出集合。
 *
 * 读 `lib/index.js` 里的 `export { ... }` 块——这是运行时事实，而不是文档或类型声明的叙述。
 * 找不到任何 export 块时返回 `undefined`（由调用方跳过，避免把「解析不到」误判成「导出缺失」）。
 */
function runtimeExports(moduleName: string): Set<string> | undefined {
  const bundlePath = join(ROOT, 'node_modules', moduleName, 'lib/index.js')
  if (!existsSync(bundlePath)) return undefined
  const code = readFileSync(bundlePath, 'utf8')
  const names = new Set<string>()
  let found = false
  const re = /export\s*\{([\s\S]*?)\}\s*(?:from\s*['"][^'"]*['"])?\s*;/g
  for (const match of code.matchAll(re)) {
    found = true
    for (const part of match[1].split(',')) {
      const trimmed = part.trim()
      if (trimmed === '') continue
      // `A as B` → 导出名 B
      const alias = trimmed.split(/\s+as\s+/)
      names.add((alias.length > 1 ? alias[1] : alias[0]).trim())
    }
  }
  return found ? names : undefined
}

describe('导出契约：源码 import 必须能在已安装的真包中解析到', () => {
  const files = collectSources(SRC)
  const imports = collectNamedImports(files)

  it('源码确实扫描到了 DSH 包导入（防止正则失效导致空跑）', () => {
    expect(files.length).toBeGreaterThan(0)
    expect(imports.length).toBeGreaterThan(0)
  })

  it('每个具名导入都存在于本地已安装包的运行时导出面', () => {
    /** 按包聚合，失败信息一次给全，避免逐个报。 */
    const missing: string[] = []
    const checked = new Set<string>()

    for (const entry of imports) {
      checked.add(entry.module)
      const available = runtimeExports(entry.module)
      // 解析不到导出面时不断言，避免把工具差异当成契约破坏。
      if (available === undefined) continue
      for (const name of entry.names) {
        if (!available.has(name)) {
          missing.push(`${entry.module} 缺少运行时导出 "${name}"（import 于 ${entry.file.replace(ROOT, '.')}）`)
        }
      }
    }

    expect(checked.size).toBeGreaterThan(0)
    expect(missing).toEqual([])
  })

  it('已安装的 primitives 版本不低于声明下限（防假绿：装了旧版却测新版契约）', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>
    }
    const declared = pkg.devDependencies['@deepseek-ai/dsh-client-ui-primitives']
    const installed = installedVersion('@deepseek-ai/dsh-client-ui-primitives')
    expect(declared).toBeTruthy()
    expect(installed).toBeTruthy()
    // 声明为精确版本时要求一致；范围声明则只要求安装版本非空即可（范围比较交给宿主门禁）。
    if (/^\d/.test(declared)) expect(installed).toBe(declared)
  })
})

describe('产物契约：迁移后的定位实现', () => {
  it('构建产物已不含被宿主删除的定位 hook', () => {
    expect(existsSync(CLIENT_BUNDLE)).toBe(true)
    const bundle = readFileSync(CLIENT_BUNDLE, 'utf8')
    expect(bundle).not.toContain('useAnchoredPosition')
  })

  it('构建产物不含矩形测量（定位不读 getBoundingClientRect）', () => {
    const bundle = readFileSync(CLIENT_BUNDLE, 'utf8')
    expect(bundle).not.toContain('getBoundingClientRect')
  })

  it('CSS 锚点主路径在场', () => {
    const bundle = readFileSync(CLIENT_BUNDLE, 'utf8')
    expect(bundle).toContain('anchorName')
    expect(bundle).toContain('positionAnchor')
  })

  it('CSS 锚点能力降级路径在场（不支持时兜底，而非错位）', () => {
    const bundle = readFileSync(CLIENT_BUNDLE, 'utf8')
    expect(bundle).toContain('CSS.supports')
    expect(bundle).toContain('anchor-name: --dsh-live-token-stats-probe')
  })
})
