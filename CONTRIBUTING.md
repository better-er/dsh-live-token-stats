# 贡献指南 Contributing

感谢你愿意为 **dsh-live-token-stats** 贡献代码。本文约定仓库的开发、CI 与发布流程，请先读完再动手。

## 仓库结构

- `src/` —— 源码。`src/index.ts` 是 host 半身即数据服务，`src/client/` 是 browser 半身即 UI。
- `tests/` —— vitest 用例，即 `tests/**/*.spec.ts`，用真实 BPE 分词表做逐 token 对照。
- `lib/` —— 发布产物，由 tsdown 构建，运行时加载的是这里；**不要手动改动**。
- `.github/workflows/` —— GitHub Actions，包含 `ci.yml` 与 `release.yml`。
- `.private/` —— 内部私有设计文档，**不对外、不入库**，已在 `.gitignore` 中排除。

## 环境

- Node ≥ 22，pnpm 9，锁文件 `pnpm-lock.yaml` 为 lockfileVersion 9。
- 首次：`pnpm install`，用 `--frozen-lockfile` 保证与锁文件一致。

## 日常开发

三条命令全部通过才算本地通过，CI 用同一套：

```bash
pnpm typecheck   # 类型检查，tsc -b
pnpm test        # 单元测试，vitest run，含 BPE 分词对照
pnpm build       # 构建产物到 lib/，tsdown
```

改动涉及对外行为或配置项时，同步更新 `README.md` 的「功能 / 配置」章节。

### 编码约定

- 注释默认中文，代码风格与仓库现有源码保持一致，不要引入破坏一致性的格式化工具。
- 依赖管理用 `pnpm add`，不要手动改 lock 或把 node_modules 提交。
- 少用 try/catch，确需时 except 分支必须带可定位错误的日志。

## 分支与提交

- 主分支：`master`。所有改动都通过 PR 进入 `master`，**不直接 push master**。
- 功能分支命名：`feature/<简述>` 新功能、`fix/<简述>` 缺陷、`docs/<简述>` 文档、`chore/<简述>` 杂项。
- 也可以按版本维护分支如 `dev/v0.3.0` 并行开发，经 PR 合入 `master`。
- 提交信息建议遵循单一职责，中文正文，可带 `feat:` / `fix:` / `docs:` / `chore:` / `bump:` 前缀，与仓库现有提交风格一致。

## Pull Request 流程

1. 从最新 `master` 拉出功能分支，提交改动。
2. 本地先过 `pnpm typecheck && pnpm test && pnpm build`。
3. 提 PR 到 `master`，按正文自述改动与自测情况；描述建议覆盖：改动内容、自测勾选、行为变化、测试说明。
4. 触发 `ci.yml`：它会在 `master` 的 push 与所有 PR 上自动跑 typecheck + test + build。
5. **CI 全绿是合并门槛**；reviewer 人工复核后合并，master 建议开启分支保护，拒绝 force push 与直接 push。

> fork PR 同样会触发 CI，但工作流不读写仓库 secrets，安全。若你的 PR 需变更 workflow 或发布相关文件，请由仓库维护者复核后再合并。

## 版本与发布 CD

- **发布 = 打 tag**：推送形如 `v0.3.0` 的 tag 即自动发版，不再需要手动改版本号。`release.yml` 自动执行：
  1. 凭 tag 号把 `package.json` 版本更新为对应值，并提交回 `master`；
  2. 测试加构建；
  3. 发布到 npm，走 Trusted Publishing：需先在 npm 包管理页把此仓库的 GitHub Actions 绑定到对应包（Enable trusted publishing → GitHub Actions → owner/仓库/branch），无需配置 NPM_TOKEN；
  4. 生成 GitHub Release **草稿**，人工确认后正式公布。
- 人只负责决定发哪个版本并打对应 tag。注意需先在 `master` 合入待发代码，再打 tag，否则发布的是旧代码。

## 注意事项

- 不到处手动执行发布动作，统一走 tag 触发的工作流，避免发布与源码不符。
- 不要在 PR 中提交 `lib/` 之外的多余产物，`node_modules`、`*.tsbuildinfo`、`.private/` 均由 `.gitignore` 排除。
- 不确定的改动，先在 issue 或 PR 里说明意图再动手。

License：本仓库协议为 [MIT](./LICENSE)，贡献即代表同意以该协议发布你的代码。