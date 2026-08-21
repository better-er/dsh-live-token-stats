# dsh·实时 Token 统计插件

模型每吐一个字，都在烧你的 token——可它烧多快、烧了多少、憋了多久才吐出第一个字，官方只在结算后给个平均值，生成中途全靠盲猜。这个插件在对话输入框下方加了一条实时状态带：边生成边报实时速度、实时输出与首字延迟，空闲时再补上上次 step 的估算 vs 实际偏差，让你心里始终有数。

纯插件自包含：不改 DSH 源码、不进任何官方 allowlist，可分发自包含。

## 功能

- **生成中**：实时速度与实时输出 token 估算随流刷新（带 `~` 表示窗口估算），provider 官方 usage 到达后立即切换为实际值；首字延迟即 TTFT。
- **等待首字**：等待时长走秒，同时展示上次 step 的估算 vs 实际偏差——等得有没有谱，一眼看穿。
- **空闲时**：显示上次结算 step 的准确速度（实际 token ÷ 耗时）与估算 vs 实际偏差，不掺实时估算。
- **估算贴近计费**：双密度 Unicode 分类——英文字符 ≈ 0.3 token/字符，中文字符 ≈ 0.6 token/字符，比官方固定的“4 字符/token”更接近真实账单。
- **不占屏**：平时不显示，有内容时一行中文标签，单位保留 `tok/s` / `token` / `s`。
- **按会话隔离**：每个会话一条投影，互不串台。

## 它长什么样

状态带在三种时刻各显示一行（全中文标签，`|` 分隔）：

**生成中（已出首字）**

```
实时速度 ~31.4 tok/s | 实时输出 ~2,123 token | 首字延迟 1.2s
```

**等待首字**

```
估算 2,123 / 实际 1,966 (+8%) | 实时输出 0 token | 等待首字 3.2s
```

**空闲（上次已结算）**

```
准确速度 28.7 tok/s | 估算 2,123 / 实际 1,966 (+8%) | 首字延迟 1.2s
```

- `实时速度 ~31.4 tok/s`：当前 step 的实时输出速率，`~` 表示窗口估算，边生成边刷新。
- `实时输出 ~2,123 token`：当前 step 的实时输出 token 估算；usage 到达后切换为官方实际值。
- `首字延迟 1.2s`：首个 token 之前的等待耗时（TTFT）。
- `估算 2,123 / 实际 1,966 (+8%)`：上次 step 的估算 vs 官方实际，括号内为偏差百分比，正号表示估算偏高；等待首字时也展示。
- `准确速度 28.7 tok/s`：上次结算 step 的实际输出 token ÷ 该 step 耗时。

## 要求

- 是**标准形态的 dsh 客户端 + 主机双半身插件**（host 提供数据服务，`./client` 提供 UI）。
- 同时声明了 `dsh.bundle`，因此也是**自挂载的 bundle 层插件**：用 `dsh plugin --profile <name> add` 安装后自动识别为 profile layer 并挂载，无需手工写组合 entry。
- 纯插件自包含，不改 DSH 源码。

## 安装

```powershell
dsh plugin --profile web add github:better-er/dsh-live-token-stats
```

一条命令装完即生效（自动挂载），重启 DSH web 后启用，无需手工编辑任何组合文件。实时行出现在 composer 卡片下方的状态带，与官方统计行并列。

## 卸载

```powershell
dsh plugin --profile web remove dsh-live-token-stats
```

彻底移除，重启 DSH web 后不再加载。

## 配置

在 profile 的 `cordis.yml` 或 overlay 中配置：

- `enabled`（boolean，默认 `true`）：总开关。
- `asciiTokenPerChar`（number，默认 `0.3`）：每个 ASCII 字符折算的 token 数。
- `cjkTokenPerChar`（number，默认 `0.6`）：每个 CJK 字符折算的 token 数。
- `rateWindowMs`（number，默认 `3000`）：实时 TPS 的滑动窗口（毫秒）。

```yaml
# 例：缩短 TPS 窗口、调高中文密度
- id: dsh-live-token-stats
  config:
    rateWindowMs: 2000
    cjkTokenPerChar: 0.65
```

## 构建与原理

两条数据流，各管各的：

- **实时 TPS 走真底层**：host 在 `llm/stream`（waterfall）上拦截每次模型调用的原始 chunk 流，按会话维护滑动窗口速率。`tool-call-delta` 的 `argumentsDelta` 在这里是逐 SSE fragment 细碎到达的真实流式工具参数（会话事件流里那段是 DSH 聚合后的整块，不是原始）。
- **传输走插件自属 RPC 通道**：host 以 `ctx.connection.rpc.handle('/dsh-live-token-stats', …, { authority: 'loopback' })` 注册插件专属端点，浏览器 ~4Hz 轮询。官方广播通道（`host/remote-event`）对第三方插件关闭，所以实时量走“插件自己的 RPC + 轮询”这条现成、公开、无条件开放的路径。
- **结算/累计走投影**：输出 token 估算与官方 usage 双字段、TTFT、偏差，由 `liveTokenStats` 投影提供，纯 fold、可重放，按会话隔离。
- **估算算法**：流式文本按字符类别分别折算——ASCII 字符（码点 ≤ 0x7F）按 `asciiTokenPerChar`，其余字符（中文、其它非 ASCII、emoji 等）按 `cjkTokenPerChar`，每段独立取整后累加：

> 上述换算标准来自 DeepSeek 官方口径：1 个英文字符 ≈ 0.3 个 token，1 个中文字符 ≈ 0.6 个 token。

- **突发保护**：单个时间戳到达的大块（比如工具参数整块送达）不会被当成 `token/1ms` 爆表，速率被摊平到一个受控下界——这正是“调 write 工具时突然飙一个巨大 tok/s”的修复。
- **开发**：`pnpm install` → `pnpm typecheck`（等价 mypy）→ `pnpm test`（等价 pytest）→ `pnpm build`；源码在 `src/`，发布产物在 `lib/`（tsdown 构建，运行时加载的是 lib）。

## 与官方 StatsLine 的关系

官方 `StatsLine` 已展示输入/输出总量、缓存命中、结算后的平均 TTFT / 平均 TPS。本插件**不复算**这些，只追加官方缺失的“流式实时”片段与上次 step 的估算偏差，两者在同一状态带并列、互不冲突。

## 已知边界

- usage 到达前为启发式（`~`）；双密度估算对混合中英文较准，仍可用两个密度配置项微调；空闲态的「准确速度」基于官方 usage，不受估算密度影响。
- 若某 step 未报告 usage，则无实际值可对比，只显示估算（带 `~`）。
- 实时 TPS 走 ~4Hz 轮询，是“准实时”而非服务端推送——这是纯插件可分发约束下的最优路径。
- 仅 Web 端（composer dock），暂无 TUI 版。

## License

[MIT](./LICENSE)