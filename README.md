# dsh·实时 Token 统计插件

模型每吐一个字，都在烧你的 token，但它烧多快、烧了多少、憋了多久才出第一个字，官方只在结算后给平均值，生成中途全靠盲猜。这个插件在对话输入框下方加了一条实时状态带：边生成边报实时速度、实时输出与首字延迟，空闲时再补上次 step 的估算 vs 实际偏差，让你心里始终有数。

纯插件自包含，不改 DSH 源码、不进任何官方 allowlist，可分发自包含。

## 功能

- **实时状态带**：composer 下方一行中文标签，三态显示——生成中报实时速度、实时输出与首字延迟；等待首字时走秒并参考上次结算偏差；空闲时显示上次 step 的准确速度与估算 vs 实际偏差。
- **真实分词估算**：实时输出 token 默认走 DeepSeek 官方口径的字节级 BPE 切分，本地内置 V4 词表，跨 delta 增量维护未完成尾段，与 provider usage 逐 token 对齐；已用 transformers 逐 token id 黄金对照验证。可选 `density` 双密度回退。
- **偏差如实对账**：v0.2.1 起工具参数按模型原始生成的文本计数，与官方按模型原始生成序列计费对齐，此前按转义后的文本计数被系统性高估；内容侧偏差清零。纯文本与推理的输出偏差约 ±1%，工具调用因官方额外计费消息模板与调用 id，本地如实在结算后显示偏差而非伪装精确。
- **诊断模式**：`debug` 开关开启后，每次模型调用的完整 delta 序列与官方 usage 落盘到 `~/.dsh/dsh-live-token-stats-debug.jsonl`，可离线逐帧核对估算。默认关闭，零开销。
- **一行制**：无论空闲还是生成中都只占一行，有内容时显示对应状态，空态也有占位文案；标签紧凑不遮挡对话，单位保留 `tok/s`、`token`、`s`。
- **按会话隔离**：每个会话一条投影，互不串台。

## 它长什么样

状态带在三种时刻各显示一行，全中文标签，用 `|` 分隔：

**生成中 · 已出首字**

```
实时速度 ~31.4 tok/s | 实时输出 ~2,123 token | 首字延迟 1.2s
```

**等待首字**

```
估算 2,123 / 实际 1,966 (+8%) | 实时输出 0 token | 等待首字 3.2s
```

**空闲 · 上次已结算**

```
准确速度 28.7 tok/s | 估算 2,123 / 实际 1,966 (+8%) | 首字延迟 1.2s
```

- `实时速度 ~31.4 tok/s`：当前 step 的实时输出速率，`~` 表示窗口估算，边生成边刷新。
- `实时输出 ~2,123 token`：当前 step 的实时输出 token 估算，usage 到达后切换为官方实际值。
- `首字延迟 1.2s`：首个 token 之前的等待耗时，即 TTFT。
- `估算 2,123 / 实际 1,966 (+8%)`：上次 step 的估算 vs 官方实际，偏差为百分比，正号表示估算偏高，等待首字时也展示。
- `准确速度 28.7 tok/s`：上次结算 step 的实际输出 token 除以该 step 耗时。

## 安装

```powershell
dsh plugin --profile web add github:better-er/dsh-live-token-stats
```

一条命令装完即生效并自动挂载，重启 DSH web 后启用，无需手工编辑任何组合文件。实时行出现在 composer 卡片下方的状态带，与官方统计行并列。

## 卸载

```powershell
dsh plugin --profile web remove dsh-live-token-stats
```

彻底移除，重启 DSH web 后不再加载。

## 要求

- 是标准形态的 dsh 客户端加主机双半身插件，host 提供数据服务，`./client` 提供 UI。
- 同时声明了 `dsh.bundle`，因此也是自挂载的 bundle 层插件；用 `dsh plugin --profile <name> add` 安装后自动识别为 profile layer 并挂载，无需手工写组合 entry。
- 纯插件自包含，不改 DSH 源码。

## 配置

在 profile 的 `cordis.yml` 或 overlay 中配置：

- `enabled`：boolean，默认 `true`，总开关。
- `tokenizerMode`：`'bpe'` 或 `'density'`，默认 `'bpe'`。`bpe` 用内置的 DeepSeek V4 词表做真实 BPE 切分，与 provider usage 最接近；`density` 回退到双密度字符估算。
- `asciiTokenPerChar`：number，默认 `0.3`，每个 ASCII 字符折算的 token 数，仅 `density` 模式生效。
- `cjkTokenPerChar`：number，默认 `0.6`，每个 CJK 字符折算的 token 数，仅 `density` 模式生效。
- `rateWindowMs`：number，默认 `3000`，实时 TPS 的滑动窗口毫秒数。
- `debug`：boolean，默认 `false`，诊断日志开关。开启后把每次模型调用的完整 delta 序列与官方 usage 落到 `~/.dsh/dsh-live-token-stats-debug.jsonl`，用于排查估算偏差；也可用环境变量 `DSH_LIVE_TOKEN_STATS_DEBUG=1` 免改配置打开。默认关闭，零额外开销。

```yaml
# 例：缩短 TPS 窗口、调高中文密度，density 模式
- id: dsh-live-token-stats
  config:
    rateWindowMs: 2000
    tokenizerMode: density
    cjkTokenPerChar: 0.65
```

## 构建与原理

两条数据流，各管各的：

- **实时 TPS 走真底层**：host 在 `llm/stream` 这个 waterfall 上拦截每次模型调用的原始 chunk 流，按会话维护滑动窗口速率。`tool-call-delta` 的 `argumentsDelta` 在这里是逐 SSE fragment 细碎到达的真实流式工具参数；会话事件流里那段是 DSH 聚合后的整块，不是原始数据。
- **传输走插件自属 RPC 通道**：host 以 `ctx.connection.rpc.handle('/dsh-live-token-stats', …, { authority: 'loopback' })` 注册专属端点，浏览器约 4Hz 轮询。官方广播通道对第三方插件关闭，所以实时量走这条现成、公开、无条件开放的路径。
- **结算与累计走投影**：输出 token 估算与官方 usage 双字段、TTFT、偏差，由 `liveTokenStats` 投影提供，纯 fold、可重放，按会话隔离。
- **估算算法**：默认 `bpe` 模式把流式文本的每个 delta 增量喂入字节级 BPE 切分器，本地内置 DeepSeek V4 词表；跨 delta 维护未完成尾段，计数与整段一次性切分逐 token 一致，并已用 transformers 输出逐 id 黄金对照验证。`density` 模式按字符类别分别折算：ASCII 字符按 `asciiTokenPerChar`，其余字符按 `cjkTokenPerChar`。
- **工具参数反转义**：模型生成工具调用时，输出序列里的参数文本是解码形态——真实换行符、真实引号，官方按这串原始生成序列计费。但协议层把参数作为 JSON 字符串序列化进 SSE 时加了一层转义：换行变 `\n`、引号变 `\"`、反斜杠变 `\\`、`\uXXXX` 等，我们逐帧拿到的是序列化后的转义原文。v0.2.1 起在计数前按 JSON 字符串值语义解码，把协议层加的转义剥掉还原模型真实生成的文本，跨帧悬空尾部由纯 JSON 状态维护，可重放——此前转义密度越大的参数越被系统性高估，write 大 content 参数曾偏 −53 token。

> 双密度换算标准来自 DeepSeek 官方口径：1 个英文字符约 0.3 个 token，1 个中文字符约 0.6 个 token。

- **突发保护**：单个时间戳到达的大块数据，例如工具参数整块送达，不会被当成 token 每秒百万的爆表，速率摊平到受控下界，这正是调 write 工具时突然飙出巨大 tok/s 的修复。
- **开发**：`pnpm install` 后依次执行 `pnpm typecheck`、`pnpm test`、`pnpm build`；源码在 `src/`，发布产物在 `lib/`，由 tsdown 构建，运行时加载的是 lib。

## 与官方 StatsLine 的关系

官方 `StatsLine` 已展示输入与输出总量、缓存命中、结算后的平均 TTFT 与平均 TPS。本插件不复算这些，只追加官方缺失的流式实时片段与上次 step 的估算偏差，两者在同一状态带并列、互不冲突。

## 已知边界

- usage 到达前仍带 `~`，本地 BPE 与云端服务端口径可能微差，偏差在结算后由官方 usage 校准；`density` 模式为启发式估算，可用两个密度配置项微调；空闲态的准确速度基于官方 usage，不受估算方式影响。
- 工具调用会话的估算会低于官方实际值：官方对 tool-call 消息的模板包装与调用 id 等额外计费，本地 delta 拿不到这部分模板文本，偏差随工具形态变化，实测单工具约 +40~60 token、双工具约 +70~80 token，并在结算后如实显示。工具参数内容本身自 v0.2.1 起按模型原始生成的文本计数、与模型原始生成序列逐 token 对齐；纯文本与推理的输出偏差在 ±1% 内。
- 若某 step 未报告 usage，则无实际值可对比，只显示估算并带 `~`。
- 实时 TPS 走约 4Hz 轮询，是准实时而非服务端推送，这是纯插件可分发约束下的最优路径。
- 仅 Web 端 composer dock，暂无 TUI 版。

## License

[MIT](./LICENSE)