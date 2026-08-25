# dsh·实时 Token 统计插件

## 引言

DeepSeek Harness 经常会看起来像卡住了，只显示**深度潜水中**而没有更详细的说明，根本不知道是在准备大惊喜还是仅仅是**溺水**了。

这里点名批评 Opencode Go，先是在 X 上宣传自己能够复现 DeepSeek 的价格，结果半夜悄悄同步涨价和峰谷价的同时，还把额度削减到原来的 1/4。虽然后续回调到 1/2，但代价是从不知道哪里找来的超级量化还超级慢又超级不稳定的模型，不仅思考强度无法调整，首字延迟还高达数十秒，完全就是溺水死掉了。

此插件两个核心功能，读取实时的大模型流式返回并实时使用 DeepSeek 分词表分词，得到实时的 token/s 计数，并在流式结束后显示估计与实际的偏差；另外轮询首字是否返回以实时更新首字延迟，用于判断是否溺水。

## 功能

- **估算算法**：默认 `bpe` 模式将流式文本的每个 delta 增量喂入字节级 BPE 切分器，本地内置 DeepSeek V4 词表；跨 delta 维护未完成尾段，计数与整段一次性切分逐 token 一致，并已用 transformers 逐 token id 黄金对照验证。可选 `density` 双密度回退，按字符类别分别折算，配置见下方。
- **偏差对账与系统误差**：输出 token 估算与官方 usage 双字段并列，结算后由 usage 校准，偏差如实显示。工具调用因官方额外计费消息模板与调用 id，本地估算会低于实际值——实测单工具约 +40~60 token、双工具约 +70~80 token；纯文本与推理输出偏差约 1~2 token。

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

- `实时速度 ~31.4 tok/s`：当前 step 的实时输出速率，`~` 表示窗口估算，边生成边刷新。usage 到达前仍带 `~`，本地 BPE 与云端口径可能微差，偏差在结算后由官方 usage 校准；`density` 模式为启发式估算，可用两个密度配置项微调；空闲态的准确速度基于官方 usage，不受估算方式影响。
- 更新机制：**实时速度**由每次流式 delta **到达驱动**即时重算；**首字延迟**由页面**轮询**实时刷新。
- `实时输出 ~2,123 token`：当前 step 的实时输出 token 估算，usage 到达后切换为官方实际值。
- `首字延迟 1.2s`：首个 token 之前的等待耗时，即 TTFT。
- `估算 2,123 / 实际 1,966 (+8%)`：上次 step 的估算 vs 官方实际，偏差为百分比，正号表示估算偏高。若某 step 未报告 usage，则无实际值可对比，只显示估算并带 `~`。
- `准确速度 28.7 tok/s`：上次结算 step 的实际输出 token 除以该 step 耗时。

## 安装

```powershell
dsh plugin --profile web add github:better-er/dsh-live-token-stats
```

一条命令装完即生效，自动挂载，重启 DSH web 后启用，无需手工编辑任何组合文件。实时行出现在 composer 卡片下方的状态带，与官方统计行并列。

## 卸载

```powershell
dsh plugin --profile web remove dsh-live-token-stats
```

彻底移除，重启 DSH web 后不再加载。

## 配置

在 profile 的 `cordis.yml` 或 overlay 中配置：

- `enabled`：boolean，默认 `true`，总开关。
- `tokenizerMode`：`'bpe'` 或 `'density'`，默认 `'bpe'`。
  - `bpe`：用内置的 DeepSeek V4 词表做真实 BPE 切分，与 provider usage 最接近。
  - `density`：回退到双密度字符估算，下方两个配置项仅在此模式生效。
    - `asciiTokenPerChar`：number，默认 `0.3`，每个 ASCII 字符折算的 token 数。
    - `cjkTokenPerChar`：number，默认 `0.6`，每个 CJK 字符折算的 token 数。
- `rateWindowMs`：number，默认 `3000`，实时 TPS 的滑动窗口毫秒数。
- `debug`：boolean，默认 `false`，诊断日志开关。也可用环境变量 `DSH_LIVE_TOKEN_STATS_DEBUG=1` 免改配置打开。

```yaml
# 例：缩短 TPS 窗口、调高中文密度，density 模式
- id: dsh-live-token-stats
  config:
    rateWindowMs: 2000
    tokenizerMode: density
    cjkTokenPerChar: 0.65
```

## 要求与开发

- 是**标准形态的 dsh 客户端加主机双半身插件**，host 提供数据服务，`./client` 提供 UI。
- 同时声明了 `dsh.bundle`，因此也是一个**自挂载的 bundle 层插件**：用 `dsh plugin --profile <name> add` 从 GitHub 安装后，会被自动识别为 profile layer 并挂载，无需手工写组合 entry。
- 纯插件自包含，不改 DSH 源码。
- 构建：`pnpm install` 后依次执行 `pnpm typecheck`、`pnpm test`、`pnpm build`；源码在 `src/`，发布产物在 `lib/`，由 tsdown 构建，运行时加载的是 lib。

## License

[MIT](./LICENSE)
