# Cradle World — 单机多 Agent 互动模拟器

一个进程里跑 N 个"主权 Agent"，每个都有真实的 Ed25519 身份、真实的
`SovereignStore` 和真实的七道闸门；它们通过 HTTP 打真实的 Discovery Server，
所以签名、计价、限流、托管、背书、PostgreSQL 状态全部是真的，只有"大脑"是合成的。

用途：

- 演示：一场"市场日"里 20 个 Agent 互相发现、谈判、委托、交付、背书；
- 回归：经济不变量（账本守恒、托管结算、声望边界）每次跑完自动校验；
- 实验：调人格比例、阶段权重、故障注入概率，看系统行为怎么变；
- 压测前的行为基线：先确认语义正确，再上纯协议压测。

## 快速开始

```powershell
# 1) 起服务（如果还没起）
cd server
$env:DATABASE_URL = 'postgres://postgres:<pw>@127.0.0.1:5432/cradle?sslmode=disable'
$env:REDIS_URL    = 'redis://:<pw>@127.0.0.1:6379/0'
$env:CRADLE_ADMIN_TOKEN = 'dev-admin-token'
go run ./cmd/cradle-server --port 8789

# 2) 跑一场 90 秒、20 个 Agent 的市场日
cd ..
$env:CRADLE_URL = 'http://127.0.0.1:8789'
$env:CRADLE_ADMIN_TOKEN = 'dev-admin-token'
node sim/world.mjs --scenario market-day --agents 20 --duration 90 --seed 42
```

输出示例：

```
=== Cradle World · market-day · seed 42 ===
agents   20 (0 reborn) · 90 ticks · 90s
traffic  1043 sent · 351 admitted · 96 rejected · 6 errors
prims    CAST 454 · PROBE 126 · DELEGATE 186 · BARTER 123 · ATTEST 118
verdict  ADMIT 351 · NO_REPLY 33 · CIRCUIT_BREAK 62
http     200 1269 · 400 6
economy  credits 7281 · gini 0.1364 · escrows 3 locked / 58 released · attestations 200
invariants 9/9 pass
  ✓ ledger conservation      20 agents: credits − 50 = Σledger
  ...
```

## 命令

```
node sim/world.mjs [选项]

--scenario <name>     market-day | sybil-storm | credit-crunch（默认 market-day）
--agents <n>          覆盖场景里的 Agent 数量
--duration <sec>      覆盖场景时长
--tick <ms>           tick 间隔（默认 1000）
--seed <n>            随机种子（默认 42）
--server <url>        默认 $CRADLE_URL 或 http://127.0.0.1:8789
--admin-token <tok>   默认 $CRADLE_ADMIN_TOKEN（充值、报告需要）
--top-up <credits>    启动时给每个 Agent 充值（默认取场景值）
--no-top-up           不充值
--out <dir>           产物目录（默认 sim/runs）
--quiet               不打印过程，只出报告
--list                列出场景
```

## 场景

| 场景 | 规模 | 看点 |
| --- | --- | --- |
| `market-day` | 20 Agent / 180s | 问候 → 谈判 → 委托 → 结算，正常经济循环 |
| `sybil-storm` | 12 Agent（40% 攻击者）/ 120s | 伪造轨迹背书、自证、负评轰炸、重放 |
| `credit-crunch` | 8 Agent / 150s | 不充值：余额耗尽 → 停止外交 → 擦除记忆 → 新世代 |

场景文件是纯 JSON：`personas`（人格与权重）、`phases`（阶段与动作权重）、`faults`（故障概率）。
新增一个场景只需要复制一份改数字，不用改代码。

## 运行原理

每个 tick（默认 1 秒）：

1. **心跳**：按 `agent.index % heartbeatEveryTicks` 错峰，避免同时打满；
   服务端一次只回 20 封邮件，所以客户端会**分批排空**邮箱，并把 `since`
   推进到"真正收到的时间戳"，否则繁忙 Agent 会静默丢消息。
2. **入站**：每封邮件先过 `plugin/lib/guardrail.js` 的七道闸门（真实代码），
   记录 verdict/gate/reason；`ADMIT` 才进入决策，并按 1200 tokens 记一次配额消耗。
3. **决策**：`phase.weights × persona.multipliers` 加权抽一个动作
   （CAST / PROBE / DELEGATE / BARTER / ATTEST / BEACON / INTRODUCE），
   用种子随机数选目标（优先本场 Agent、优先能力标签匹配）。
4. **发送**：`createEnvelope` 真实签名 → `POST /v1/send` → 记录状态码与扣费。
5. **故障注入**：按概率制造重复发送、篡改签名、过期时间戳、伪造轨迹背书、自证。

对话遵循真实协议：回复时把**自己的 DID** 追加到 `hop_history`，所以第二轮之后
接收方会触发 `CIRCUIT_BREAK`——这是当前插件的真实行为，不是模拟器的 bug。

## 产物

每次运行生成 `sim/runs/<时间>-<场景>-<seed>/`：

- `events.jsonl`：逐事件时间线（`send` / `inbound` / `fault` / `rebirth` / `error`），
  含 tick、阶段、Agent、原语、状态码、扣费、trace、guardrail verdict；
- `summary.json`：汇总、HTTP 直方图、经济指标、不变量结果；
- `state/`：每个 Agent 的 `sovereign.json`（真实插件存储格式）。

### 不变量

报告从**管理 API** 读取数据来校验，不依赖模拟器自己的记账：

| 不变量 | 含义 |
| --- | --- |
| `traffic` | 确实产生了收发 |
| `credits non-negative` | 所有余额 ≥ 0 |
| `reputation bounds` | 声望 ∈ [0.1, 10] |
| `ledger conservation` | 每个 Agent：`credits − 50 = Σledger.delta` |
| `escrow payouts recorded` | 每条 RELEASED 托管都有对应入账 |
| `attestation bounds` | verdict ∈ {−1,0,1}，\|weight\| ≤ 1 |
| `idempotent replay` | 重复的 `message_id` 返回 duplicate 且不扣费 |
| `fault rejection` | 篡改/过期信封一律 400 |
| `guardrail rejects abuse` | 攻击场景里确实有入站被拒 |

## 可复现性

- 决策序列由 `--seed` 决定；同一 seed + 同一场景 + 全新数据库 = 同一串动作。
- 服务端状态是共享的：在同一个库上连跑两次，余额、声望、trace 会不同。
  需要严格复现时，先清空数据（测试库可直接 `store.Reset`，或重建 `cradle` 库）。
- 每个 Agent 的 RNG 独立播种（`seed * 7919 + index * 104729`），
  所以增减 Agent 数量只影响新增/删除的那几个，不会打乱其他人的决策流。

## 单机约束与对策

| 服务端约束 | 模拟器的处理 |
| --- | --- |
| 在线 TTL 45s | 每 10 tick 心跳一次，错峰 |
| 发送限流 120/min/Agent | 每人每 tick 最多 1 个动作，20 Agent ≈ 20–40/min |
| 注册限流 30/min/IP | 注册间隔 25ms + 429 退避重试 |
| 心跳每次最多 20 封 | 分批排空（最多 6 批），`since` 只推进到已收时间戳 |
| 邮箱上限 100 封 | 心跳频繁，正常场景不会触顶；长跑请缩短 tick |
| UBI 每小时 | 短场景等不到，用 `--top-up` 预充值 |
| 托管 24h 过期 | 场景内不会触发；报告会把长期 LOCKED 的托管单独列出 |
| 信封 32KB / anchor 400 字符 | 模板文本远小于上限 |

## 扩展

- **接真模型**：把 `lib/text.mjs` 换成一个 LLM 适配器（本地 Ollama 或
  `plugin/lib/model.js` 的 `generateReply`），策略层不用动。
- **新场景**：复制 `scenarios/*.json`，改人格比例、阶段权重、故障概率。
- **CI**：`node sim/world.mjs --scenario market-day --agents 8 --duration 30 --quiet`
  退出码即不变量结果，可直接当冒烟测试。
- **故障演练**：停 Redis、重启服务、删库，观察降级与恢复。

## 已知限制

- 单进程串行调度，单机上限大约几百个 Agent；再往上需要多进程分片。
- 文本是模板，不评估语言质量；它验证的是协议与经济，不是对话能力。
- 不模拟人类审批队列（L2 的 `PENDING_HUMAN`），只统计 verdict。
- 服务端没有托管过期清扫任务，长期 LOCKED 的托管需要运营侧处理。

## 自测

```powershell
node sim/test/sim.test.mjs
```

覆盖：种子确定性、权重抽样、模板确定性、意图收敛、攻击者负评倾向、
场景文件结构校验。
