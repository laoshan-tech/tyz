# Agent 端全盘重构方案：基于 Realm 的 Rust 数据面

> 状态：方案 v3 + 实施记录（M1~M3 已实现并通过测试，M4 切换待执行）
> 日期：2026-08-29（v3 修订与实施同日）
> 范围：`apps/agent`（Go + 内嵌 GOST）→ `apps/agent`（Rust + Realm 数据面）；server 端配套改动（**零表结构变更**）
> 一期功能边界：**配置同步、流量统计并上报**。限速/限流/本地配额闸门**不做**；中转协议以 Realm 自身为准，不复刻 GOST。

## 0.0 实施记录（2026-08-29，M1~M3 完成）

**已完成并验证**（`bun test` 26 绿 / `bun run type-check` 三工作区绿 / `cargo test` 18 绿含 e2e / `cargo clippy` 0 警告 / release 构建 5.0MB）：

- M1 server：`buildRealmNodeConfig` 渲染器（`db/repo.ts`）、`nodeRuleTunnels` 闸门（OUT 恒计入）、写入校验收紧（forward_mode 退役/链类型 raw|tls/strategy round|iphash）、面板收敛（隧道/链表单）、shared 层 `RealmNodeConfig` schema、渲染器单测 `apps/server/test/realm-config.test.ts`。
- M2/M3 agent（`apps/agent`，lib+bin）：agentcfg / model / translate / stats（双层样本+合并+分块）/ certs / store / cp::http（304+8MiB 上限）/ cp::ws（完整状态机）/ control（退避+jitter+flush）/ runtime（Supervisor diff-apply、受管 accept、restart、健康快照、专用 splice 零拷贝计数引擎、kaminari TLS 装配、realm_lb 选路）。
- 测试：`tests/e2e.rs`（mock 控制面 + 双 Supervisor 真实转发 + 统计上报断言 + 304 + 重启指令 + 目标热切换）、`tests/tls_e2e.rs`（kaminari TLS 链路 + 明文探测拒绝）、`runtime/zero.rs` 单测（计数与 realm_io `bidi_zero_copy` 总量对照、brutal 语义）、ws 状态机单测（交付/降级/回升）。

**实施中的偏差与发现**（相对 §5.5/§6 的设计）：

| # | 偏差 | 原因与处置 |
|---|---|---|
| I1 | 零拷贝计数不再是"外部 `AsyncIOBuf` 实现"，而是 `runtime/zero.rs` 内约 150 行的 **TcpStream 专用 splice 状态机**（复用 realm_io 公开的 `AsyncRawIO::poll_read_raw/poll_write_raw` 原语 + 相同 splice 序列 + 相同 brutal-shutdown 完成语义） | 孤儿规则（E0117）：外部 crate 无法为 `CopyBuffer<LocalBuf,…>`（外部 trait + 外部泛型 Self、局部类型仅嵌套）实现 trait。属 §17-R2 预案的范围，依旧零 fork；计数点仍是 write-splice，单测与 realm_io 总量对照通过 |
| I2 | ~~`realm_lb` **vendored**~~ → 已改回上游：crates.io 版 iphash 的哈希用 `unchecked_{mul,add}` 做本应 wrapping 的溢出乘加，debug 构建的前置条件检查直接 abort 进程。修复 PR（#172，`51c0413`，wrapping 算术 + 移除 `#![feature(unchecked_math)]`）已合入上游 master；因当时未发 crates.io 版本，依赖暂钉 git rev：`realm_lb = { git = "…zhboner/realm", rev = "51c0413…" }`（Cargo.lock 锁定，可复现）。**上游发版后换回版本号依赖即可** |
| I3 | **nightly 工具链**：kaminari 使用 `impl_trait_in_assoc_type`（未稳定），整条依赖链须 nightly；`rust-toolchain.toml` 钉死 `nightly-2026-08-28` | realm 生态自身的构建基线即 nightly；钉日期保证发布可复现 |
| I4 | WS 状态机补了**连接成功即回升**（`failures.clear()` + 立即 mode 更新）——最初实现只在会话结束后重算 mode，降级后将永远卡在 poll 模式 | 与 Go 版 `c.failures = nil` 对齐；由 ws 状态机单测暴露（曾导致测试挂起） |
| I5 | 统计样本 serde 需要 `rename_all = "camelCase"`（`inputBytes` 等契约字段） | e2e 对 mock 控制面抓到（snake_case 会被 server zod 400）——集成测试的价值实证 |
| I6 | apply 的**同端口重建**语义：先停旧 listener 再起新（双 bind = EADDRINUSE）；端口变更仍走"先新后旧"零中断路径 | e2e 热切换用例暴露 |
| I7 | TLS 出口对明文探测回 **TLS alert 短记录**（≤8 字节）后断开——与 nginx 等真实 TLS 服务一致；e2e 断言为"探测请求永不回显" | kaminari/rustls 服务端的标准行为 |
| I8 | **R4 的分钟级缓解（server 侧，2026-08-30）**：stats 摄取返回本批计费的规则 id，`quotaSweepStoppedUsers`（`services/quota.ts`）解析其属主的硬停决策，并对"规则仍部署在某个 `node_configs` 快照里"的 stopped 用户触发 `recomputeUserNodes`（重算 + WS 推送）。挂载在 `POST /api/agent/stats` 的 `waitUntil` 里（对齐 admin 的 `deferRecompute` 模式），超用窗口从"最长一个 cron 周期"缩到"一个 flush 周期" | 幂等靠部署扫描：规则退出所有配置后，后续 flush（残留缓冲样本、慢 agent）只花一次索引查询即短路；非流量类硬停原因（禁用/过期/无订阅）本就由管理写入即时重算，sweep 触碰到它们等于自愈上次失败的重算；每日 cron 仍是兜底 |
| I9 | **死监听自愈（agent 侧，2026-08-30）**：`Supervisor::apply` 对 accept loop 已退出的服务（`ServiceHandle::is_dead`）无条件重建，即使配置未变——gostapply 的 dead-service self-heal 在 realm 侧的对应物。纯自愈路径保持存量连接不断（死的是 accept loop，不是已建立的连接任务），也不触发 TLS 强制重建 | 此前 accept loop 因致命 accept 错误退出后，服务会一直停在 `failed` 健康状态，直到下次配置变更或手动重启；单测覆盖"自愈后新连接恢复 + 旧连接存活 + 未变化配置不重建健康服务" |

**M4（切换）待办**：~~staging 全流程演练（含回滚）~~、~~按方案 §14 整体切换~~ 之外的全部代码/资产面工作已完成（2026-08-30）：`apps/agent` 与 gost 资产已删除；`test:agent`/`dev:agent`/`clippy:agent` 指向 rust；AGENTS.md 全文改写为 realm 时代口径；发布流水线落地（`agent-release.yml` 构建 amd64/arm64 gnu 二进制 + SHA-256 附到 release；`docker-build.yml` 改用 `apps/agent/Dockerfile`，原生交叉编译、无 QEMU 仿真）；`check.yml` 的 Go 步骤换成 clippy（-D warnings）+ cargo test。剩余：staging 演练与线上整体切换的实际执行。

## 0. 已确认的决策记录

| # | 决策 | 对方案的约束 |
|---|---|---|
| D1 | **零拷贝（splice）必须保留**——realm 的核心优势 | 数据面明文腿必须走 `realm_io` 的 splice 路径；字节统计不得经由用户态包装流（§5.5、§9.7 给出零 fork 的计数方案） |
| D2 | **mTLS 暂不实现，TLS 尽量复用 realm 的库** | TLS 链路 = kaminari（realm 的 TLS 栈，rustls 后端）；无证书互验（Q1 确认接受） |
| D3 | **不做 gost/realm 共存，干脆替换；server 表 schema 尽量不变** | 不加列、不写 migration；realm 渲染器成为唯一路径；整体切换（§14） |
| D4 | **IP 准入检查不做** | 配置/agent 均无 `allow_from`；TLS 出口端口对任意来源开放（风险与恢复杠杆见 R1） |
| D5 | **socket 选项不做（NODELAY / keepalive 均不设置）** | 拨号后直接进入转发；Nagle 保持内核默认（小包交互可能引入 ~40ms 级延迟，吞吐无影响；见 O5） |
| D6 | **引入 realm_lb**（现有 `chains.strategy` 列本就为 LB 预留） | 多出口隧道的入口服务按 strategy 做真实负载均衡（§7.4、§9.7），复用 realm_lb 库 |

### 0.1 决策点拍板结果（已确认）

| # | 问题 | 拍板结果 |
|---|---|---|
| Q1 | TLS 链路无认证（入口 `insecure` 不验证服务端、出口不验客户端、不锁 SNI、无准入） | **确认接受**（§11/R1） |
| Q2 | 存量 relay 模式两节点隧道的归宿 | **自动降级为 raw 端口对渲染**（§7.3，规则无感继续跑） |
| Q3 | 闸门口径变化（存量 relay 隧道出口腿开始计费）的运营公告 | **不涉及，无需公告**（`nodeRuleTunnels` 口径改动按 §7.5 执行） |
| Q4 | 存量多跳隧道的处理 | **不涉及**（渲染器跳过逻辑保留作防御，§7.3） |
| Q5 | 切换流程 | **方案 A：维护窗口整体切换，不做任何过渡**（不发 Go agent 终版补丁），见 §14 |
| Q6 | DNS 解析 + connect 的归属 | 澄清见 §5.5/D.3：**不是自研解析器**，是标准库一行调用；realm_core 的对应函数在私有模块不可复用 |
| Q7 | TLS 握手能否直接用 realm 的 | **能，且方案本就如此**：kaminari 就是 realm 的 TLS 实现，realm_core 只是转手调用它（§5.5） |

---

## 1. 背景与动机

- 国内中转服务器频繁因流量特征被识别而关停。GOST 的 relay 协议、observer 周期行为、TLS 握手指纹（Go crypto/tls ClientHello 等）经过多年公网部署，已存在被主动探测/被动指纹识别的现实风险。
- 现有 Go agent 将 GOST 运行时**嵌入进程**（go-gost/x），职责过重：builder（GOST 对象渲染）、gostapply（注册表 diff）、observer、限速器、配额对象……这些能力大部分与本平台核心诉求（透明转发 + 计量）无关，却全部进二进制。
- Realm（[zhboner/realm](https://github.com/zhboner/realm)，v2.9.5，2026-08 仍在维护）是一个纯 Rust 的高性能 L4 中继：**数据面就是明文 TCP/UDP 双向拷贝（Linux 上 splice 零拷贝）**，可选标准 TLS/WS 传输（kaminari），没有任何自有协议头。以它为基础意味着：线上流量形态 = 普通服务器到服务器之间的 TCP/TLS 连接，与 nginx/caddy 反代、数据库复制等业务流量不可区分。

**本次重构要解决的问题：**

1. 去除 GOST 运行时及其全部特征（协议头、握手指纹、行为模式），**保留 realm 的零拷贝性能优势**；
2. 数据面收敛为 Realm 语义的透明转发（明文 TCP splice 零拷贝，TLS 复用 kaminari）；
3. 保留平台赖以运转的三件事：**配置同步**（WS 推送 + HTTP 兜底 + 版本化快照 + 离线引导）、**流量统计**（按服务/按客户端的累计计数）、**上报**（`POST /api/agent/stats`，服务端 ingest/计费/健康面板零改动）。

---

## 2. 目标与非目标

### 目标（一期）

| # | 目标 | 验收标准 |
|---|------|---------|
| G1 | Rust 重写 agent（`apps/agent`，二进制 `tyz-agent`） | 单二进制，交叉编译 linux/amd64 + arm64，Docker 镜像 |
| G2 | 与 server 的配置同步完全对齐现有协议 | `GET /api/agent/config?version=N` 304/200 语义、`GET /api/agent/ws` 推送通道、断线降级/探测恢复状态机、`last-config.json` 离线引导 |
| G3 | 流量统计并上报，**server 端 ingest / 计费 / 健康面板接口零改动**（除 Q3 的闸门口径） | `POST /api/agent/stats` 的 samples/health 字段逐字段对齐 Go 版；`traffic_hourly`、`service_health`、规则状态写回照常工作 |
| G4 | 数据面行为 = Realm：明文 TCP L4 透明转发，**Linux 走 splice 零拷贝**；TLS 链路复用 kaminari（rustls） | 无任何自有协议字节；对端跑原版 realm 二进制时互联互通；吞吐/延迟不低于 realm 基准（压测验收） |
| G5 | 服务编排兼容现有 raw 模式语义：每规则独立端口对、`service-{ruleId}` 命名、exit_port 自动分配公式沿用 | 面板健康/重启指令/计费归因无需感知迁移（§7、§13） |
| G6 | 多出口负载均衡：复用 `chains.strategy` 列 + realm_lb，多 out 链隧道在入口按策略分流 | roundrobin 均匀分布、iphash 同客户端粘滞（§7.4、§15） |
| G7 | 一次性替换：**零表结构变更**，按 §14 流程切换，可整体回滚（旧 server + 旧 agent 回退） | 切换演练通过；回滚预案验证 |

### 非目标（一期明确不做）

- **限速/限流**：`rule.limit`（traffic/request/connection limiter）不进入 realm payload；
- **本地配额闸门**：GOST quota 对象不存在 → 配额硬停只靠 server 聚合剔除（recompute 推送 + 每日 cron），接受推送间隔内的超用窗口（§13）；
- **mTLS / IP 准入**（决策 D2/D4）：TLS 链路 = kaminari 单向加密（入口 `insecure`），出口不验客户端、不锁 SNI、不限来源 IP；
- **socket 选项**（决策 D5）：不设 NODELAY/keepalive，全部内核默认；
- **relay 协议 / 共享出口端口**：不复刻。所有隧道按 raw 端口对语义渲染；
- **多跳（3+）隧道**：渲染器跳过（Q4）；
- **ws/wss 传输**：一期链路只有明文 TCP 与 TLS。wss 二期直接加 kaminari 的 ws conf 即可（库已具备，见 §17-R3）；
- **realm_hook**：一期不接（现状分析见附录 E）；
- **UDP 转发**：二期（realm 自带 UDP full-cone NAT 语义，schema 预留 `network.udp` 字段位）；
- **agent 自身 HTTP 管理面**：不做（DEBUG 只控制日志级别）。

---

## 3. 设计原则（硬约束）

1. **server 对 agent 的三个 HTTP 端点一字不改**（auth、路径、请求/响应 schema、状态码语义）。
2. **零拷贝不可妥协**（决策 D1）：明文腿统计必须在 splice 路径内联完成（§5.5），不得退化为用户态包装流。
3. **计费口径明确**：`traffic_hourly` 是唯一账本；全 raw 语义后两腿（入口腿 + 出口腿）都计入、按节点 `rate` 折算（Q3 闸门调整后存量隧道口径统一）。
4. **确定性命名**：`service-{ruleId}` 服务名原样保留——计费归因闸门（`nodeRuleTunnels`）、规则状态写回（`/^service-(\d+)$/` 解析）、手动重启指令（`restart_service`）、健康面板全部依赖这个名字。
5. **部分失败可恢复**：对齐 gostapply 语义——单服务 bind 失败不影响其他服务，标记 `apply_failed` 进健康快照，版本不采纳、下轮重试。
6. **保守的断线策略**：配置变更时既有连接尽量保活；操作员显式断流走"手动重启"指令；TLS 材料轮换例外。
7. **密钥纪律**：NODE_TOKEN 与 PEM 材料只存在于内存、`certs/`、`last-config.json`（0600/0700），日志永不输出。
8. **零表结构变更**（决策 D3）：退役语义只改代码路径与渲染策略，不写 migration（§7.3）。

---

## 4. 现状契约盘点（必须原样保留的接口面）

以下契约从现有代码逐条核对得出，是 rust agent 的验收基准。

### 4.1 配置拉取 —— `GET /api/agent/config?version=N`

- 认证：`Authorization: Bearer <NODE_TOKEN>`（`relay_nodes.token` 明文直查，isolate 内 60s 缓存）。
- `version` 缺省 = 0；非负整数，否则 400。
- `snapshot.version <= N` → **304 空体**；否则 200 `{ version, config }`（`routes/agent.ts:43-46`）。
- 节点从未物化过快照时 server 会按需聚合一次再返回。
- agent 侧约束（Go 版，需对齐）：HTTP 超时 30s；响应体上限 8 MiB；失败走指数退避。

### 4.2 推送通道 —— `GET /api/agent/ws`（Upgrade: websocket）

- 同 Bearer 认证；升级请求被转发到该节点的 `NodePushDO`（每节点一个实例）。
- **保活是文本消息**：agent 定时发送文本 `"ping"`，DO 通过 `setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))` 在边缘自动回 `"pong"`，对象保持休眠（`do/nodePush.ts:29`）。⚠️ 不能用 WS 协议层 ping 帧——DO 的自动应答只匹配文本消息。
- 下行消息只有两种（JSON 文本）：
  - `{"type":"config_changed"}` → 立即触发一次配置拉取；
  - `{"type":"restart_service","service":"service-42"}` → 只重建该服务（源是本地最后期望配置，**不**重新拉取），节点上不存在该服务则 no-op。
- Cloudflare 边缘空闲 ~100s 断 WS → ping 间隔默认 60s、硬上限 90s。
- 状态机（`cp/ws.go`）：WS 模式下 HTTP 轮询只是 5 分钟安全网；**每次成功（重）连接触发立即拉取**（弥补断线窗口丢失的广播）；60s 滑动窗内 ≥3 次失败 → 降级 HTTP 轮询；降级期间每 `WS_PROBE_INTERVAL_MS`（60s）探测一次，成功即回升；重连退避 1s→60s 指数。

### 4.3 统计上报 —— `POST /api/agent/stats`

- 请求体 `{ samples: GostStatsSample[], health: ServiceHealthSample[] }`（zod `agentStatsBatchSchema`：两者均可 null/缺失并归一为 `[]`，至少一项非空；samples ≤1000、health ≤500）。rust 侧用 `Vec` 序列化 `[]`，天然合规。
- `GostStatsSample`（**累计计数器**，不是增量）：

```jsonc
{
  "service": "service-42",     // 命名见原则 4
  "client":  "1.2.3.4",        // 服务级样本 client 为空串/缺省
  "totalConns": 17,            // 累计连接数
  "currentConns": 3,           // 当前活跃连接（小时 rollup 取窗口峰值）
  "inputBytes": 1048576,       // 累计：客户端 → 服务（upload）
  "outputBytes": 2097152,      // 累计：服务 → 客户端（download）
  "totalErrs": 2
}
```

- **账本只消费服务级样本**（`traffic.ts:101` `samples.filter(s => !s.client)`）：与 `traffic_counters` 里上一份累计值做差；计数器回退（agent 重启/服务重建）按"当次全量"计（宁多勿少）。带 client 的样本只作为 `gost_stats` 的明细行。→ **rust agent 必须发双层样本：每服务一条（client 为空）+ 每客户端一条**。
- `ServiceHealthSample`：`{ service, state, error? }`，`state ∈ running|ready|failed|closed|apply_failed`（rust 版使用 `running|failed|apply_failed`）。health 是**全量快照**：server 会 upsert 全部条目并**删除快照里消失的服务**，还从中推导 `relay_rules.status`（`ready|running → running`，`failed|apply_failed → error`，`paused` 永不覆盖）。
- 上传节奏：flush 间隔 `STATS_FLUSH_INTERVAL_MS`（默认 60s），**启动相位随机化**（防机队齐步踩点）；缓冲上限 1000 条 drop-oldest；**每批 ≤20 个样本**（D1 100 绑定参数上限，server 端按 20 行/语句插入），部分失败时**裁剪已成功前缀**再整批重试；同 `(service, client)` 连续样本在缓冲内合并（保留最新累计值 + 窗口内 `currentConns` 峰值）；SIGTERM 触发 final flush。
- 空载节点也要按时上报 health（samples 可为 `[]`）——健康面板靠它刷新。

### 4.4 版本与离线引导

- `node_configs.version`：epoch 秒基准、单调递增；agent 内存持有版本，**进程重启归零**（全量刷新）。
- `last-config.json`：最后一次成功应用的完整响应体；原子写（tmp + fsync + rename）；启动时重放缓存配置、以其版本为轮询基线（未变更则一次 304）；损坏/过期则跳过并告警。

---

## 5. Realm 调研结论与选型

### 5.1 生态结构（master@2026-08，v2.9.5）

| crate | 版本 | 角色 |
|---|---|---|
| `realm`（bin） | 2.9.x | 配置层（TOML/JSON/env → `EndpointConf`）+ 进程管理，无热重载 |
| `realm_core` | 0.5.1 | 数据面骨架：`endpoint::{Endpoint, BindOpts, ConnectOpts, RemoteAddr}`、`tcp::run_tcp`、`udp` |
| `realm_io` | 0.5.4 | 拷贝引擎：`bidi_copy_buf`（泛型于 `AsyncIOBuf`）、Linux `bidi_zero_copy`（splice 零拷贝）、`statistic::StatStream`（feature `statistic`） |
| `kaminari` | 0.14 | 传输层：ws/tls/wss（rustls + lightws），`MixAccept/MixConnect`，conf 解析函数公开 —— **realm 的 TLS 实现** |
| `realm_lb` | 0.1 | 负载均衡：`Balancer`（off/iphash/roundrobin + 权重），`BalanceCtx{src_ip}` —— 决策 D6 引入 |
| `realm_hook` | 0.1 | pre-connect 钩子（运行时 .so，首包决定选路/拒绝）—— 现状分析见附录 E，一期不用 |

realm 的数据面语义：`run_tcp(endpoint)` = bind → accept 循环 → 每连接 spawn `connect_and_relay`：拨号远端（可选 transport 握手，可选 LB 选路）→ 双向拷贝（明文走 splice 零拷贝，transport 走用户态）。**没有协议、没有多路复用、没有认证**——每个 endpoint 就是一条 `listen → remote(s)` 的透明管道。

### 5.2 直接以 `realm_core::run_tcp` 为库的三个硬伤

1. **黑盒**：唯一公开入口，内部 accept 循环自持 listener，没有每连接回调、没有字节回调 → 统计上报（硬需求）无从挂接；
2. **bind 失败直接 `panic!`**（`realm_core/src/tcp/mod.rs:34`）：realm 假设静态配置；动态 apply 需要"bind 失败 → 该服务 `apply_failed`，其余照常"；
3. **无优雅停止/单服务重启**：停一个 endpoint 只能 abort task，无法区分"关 listener 保连接"与"断流重建"。

### 5.3 kaminari 的 TLS 能力边界（决策 D2/Q1 的依据）

kaminari TLS 选项（realm 的 `listen_transport`/`remote_transport` 字符串，解析函数 `kaminari::opt::get_tls_{client,server}_conf` **公开**，conf 结构体字段公开）：

- 客户端：`sni`（必填）/ `alpn` / `0rtt` / `insecure`——**无自定义 CA、无客户端证书**；
- 服务端：`cert` + `key`（文件路径）或 `servername`（自签）/ `ocsp`——**无客户端证书验证（无 mTLS）、无 SNI 锁定**。

平台现有自签 CA 双向认证在 kaminari 上表达不出来；按决策 D2/Q1 接受无验证（§11）。

### 5.4 数据面路线（结论）

| 路线 | 说明 | 统计 | 零拷贝 | 动态 apply | TLS/LB | 结论 |
|---|---|---|---|---|---|---|
| A. 子进程拉起 realm 二进制 | realm 无热重载、无统计输出 | ❌ | ✅ | ❌ | ✅ | 否决 |
| B. 依赖 `realm_core::run_tcp` | 黑盒 + bind panic | ❌ | ✅ | ⚠️ 粗粒度 | ✅ | 否决 |
| C. **自建受管 accept/relay 层，直接组合 realm 生态公开原语**（`realm_io` 拷贝引擎 + `kaminari` TLS + `realm_lb` 均衡；Endpoint 模型照搬 `realm_core::endpoint`） | 见 §5.5/§9.7 | ✅ splice 内联计数 | ✅ | ✅ | ✅ | **采纳** |
| D. fork realm_core/realm_io 加回调 | 可行但背 fork | ✅ | ✅ | ✅ | ⚠️ 同上 | **不需要** |

### 5.5 关键结论与澄清

**（1）零拷贝路径的统计可以零 fork 挂接**（数据面基石，已对照 `realm_io` 源码核实）：

1. `bidi_zero_copy(a, b)` 的实现就是 `bidi_copy_buf(a, b, CopyBuffer::new(Pipe), CopyBuffer::new(Pipe))`——拷贝引擎 `bidi_copy_buf` **泛型于公开 trait `AsyncIOBuf`**（`realm_io/src/buf.rs:41-51`，无 sealed），缓冲类型决定 IO 方式：`Pipe` 缓冲 → `splice(sock→pipe)` + `splice(pipe→sock)`（`linux/zero_copy.rs`），`Vec<u8>` 缓冲 → 用户态 read/write；
2. `CopyBuffer::new`、`AsyncIOBuf`、`AsyncRawIO`（含 `poll_read_raw/poll_write_raw`，`TcpStream` 已实现）全部在 crate 根公开导出；
3. 因此可以在**我们自己的 crate** 里定义 `CountingPipe`（自建 `pipe2` + `splice`，~50 行，`Pipe` 字段私有导致需复制而非复用结构体本身），为 `CopyBuffer<CountingPipe, TcpStream, TcpStream>` 实现 `AsyncIOBuf`：`poll_write_buf` 在 splice 返回处把字节数原子累加——**零拷贝分毫未动，双向实时计数白拿**；
4. TLS/transport 腿本来就不走 splice（realm 自身如此）：用户态 `bidi_copy_buf` + `realm_io::statistic::StatStream`（写侧计数包装，feature `statistic`）；
5. 非 Linux（开发机）：回退 `StatStream` + 用户态拷贝（条件编译），生产行为不变。

**（2）DNS 解析 + connect 为什么"自己写"（Q6 澄清）**：这里**没有自研解析器**——所谓"自研拨号"就是 `tokio::net::TcpStream::connect((host, port))` 一行标准库调用（系统解析器 getaddrinfo，OS 级缓存 nscd/systemd-resolved 生效，域名按连接重解析）。realm 二进制里对应的 `socket::connect` + hickory 全局解析器在 `realm_core` 的**私有模块**里不导出，所以这几行胶水必须落在我们的 `net.rs`；若未来想对齐 realm 的 hickory 异步缓存解析，直接依赖 `hickory-resolver` 即可（`realm_core::dns` 也只是它的薄封装）。

**（3）TLS 握手就是"直接用 realm 的"（Q7 确认）**：kaminari **就是** realm 的 TLS 实现——`realm_core` 的 transport 模块只是转手调用 kaminari（`realm_core/src/tcp/transport.rs` 直接 `use kaminari::{AsyncAccept, AsyncConnect, mix::…}`），自身没有一行 TLS 代码。我们绕过转手层直接调用 kaminari，用的是**同一个库、同一套 conf 结构体、同一份选项串语法**，与 realm 二进制的 TLS 腿在 wire 上完全一致。

> 与 realm 的关系界定：**协议形态与 IO 路径 100% 是 realm 的**（splice 零拷贝、kaminari rustls TLS、realm_lb 选路、缓冲/管道尺寸、超时默认值全部沿用 realm 取值）；新写的只有 realm 作为通用工具不提供、平台必须有的纳管层（受管 accept 循环、diff-apply、计数聚合、健康），约 700 行。

---

## 6. 总体架构

### 6.1 进程结构

```
                        ┌────────────────────────── tyz-agent（Rust, tokio）──────────────────────────┐
                        │                                                                            │
  control plane ◄───────┤  cp::http   config?version=N (304/200)      stats 分块上传（≤20/批）          │
  (CF Worker + DO) ├────┼─►cp::ws     文本 "ping"→"pong"；config_changed / restart_service              │
                        │        │ Wake                                                              │
                        │        ▼                                                                    │
                        │     loop ── 拉取 → certs 落盘 → translate → runtime::apply（diff）            │
                        │        │                        ▲                      ├─ 受管 accept loop     │
                        │        │                        │ restart 指令          ├─ LB 选路 [realm_lb]  │
                        │        │                        │                        ├─ dial(明文/kaminari) │
                        │        │                        │                        ├─ 明文腿: CountingPipe │
                        │        │                        │                        │   splice 零拷贝+计数  │
                        │     store（last-config.json 原子写/离线引导）             └─ TLS腿: StatStream    │
                        │     certs（PEM 落盘，变更标志 → 强制重建 TLS 服务）              用户态拷贝+计数    │
                        │     stats（(service,client) 累计器 → 合并 → 分块 → POST /api/agent/stats）◄──┘ │
                        └──────────────────────────────────────────────────────────────────────────────┘
```

### 6.2 crate 布局

```
apps/agent/
├── Cargo.toml
├── .env.example                    # 与 Go 版同名同义（见附录 A）
├── Dockerfile                      # 多阶段：chef 构建 → distroless/static 运行
├── src/
│   ├── main.rs                     # 装配、信号（SIGTERM/SIGINT → 停 WS + final flush + 停服务）、--version
│   ├── agentcfg.rs                 # env/dotenv 加载，非法数字报错不静默
│   ├── model.rs                    # RealmNodeConfig DTO（serde；未知字段容忍、缺字段报错）
│   ├── translate.rs                # payload → 期望态 Vec<DesiredService>（校验 + 确定性命名）
│   ├── cp/
│   │   ├── mod.rs
│   │   ├── http.rs                 # reqwest：config 拉取（304/200，8MiB 上限）、stats 上传（分块+裁剪）
│   │   └── ws.rs                   # tokio-tungstenite：状态机（对齐 Go 参数）
│   ├── loop.rs                     # 主循环：退避+jitter、Wake、安全网轮询；版本只在成功后采纳
│   ├── runtime/
│   │   ├── mod.rs                  # Supervisor：diff-apply、restart、健康快照、优雅停止
│   │   ├── service.rs              # 单服务：bind/accept 循环（bind 失败返回 Err 不 panic）、连接表
│   │   ├── net.rs                  # LB 选路（realm_lb）+ 拨号（标准库 connect / kaminari 握手）
│   │   ├── zero.rs                 # CountingPipe：AsyncIOBuf 实现（splice 零拷贝 + 原子计数）
│   │   └── tlsconf.rs              # kaminari MixAccept/MixConnect 构建（cert/key/sni/alpn/insecure）
│   ├── stats.rs                    # 累计器注册表、双层样本生成、缓冲合并、1000 上限
│   ├── certs.rs                    # PEM 原子落盘（不变跳过；changed 标志）
│   └── store.rs                    # last-config.json 原子写 + 启动重放
└── tests/                          # 集成测试（本地 WS server、端到端转发、零拷贝计数精确性、LB）
```

### 6.3 依赖清单

```toml
[dependencies]
tokio = { version = "1", features = ["rt-multi-thread", "net", "io-util", "time", "macros", "signal", "sync", "fs"] }
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "json"] }  # 控制面 HTTPS（与数据面 TLS 无关）
tokio-tungstenite = { version = "0.24", features = ["rustls-tls-webpki-roots"] }
realm_io = { version = "0.5", features = ["statistic", "brutal-shutdown"] }  # 拷贝引擎 + StatStream + 断连语义（见 §6.4）；Linux 零拷贝内建
kaminari = { version = "0.14", features = ["tls-ring", "mix"] }             # 数据面 TLS（ring 后端，见 §6.4；ws 特性二期再开）
realm_lb = "0.1"                                           # 多出口负载均衡（Balancer/BalanceCtx）
libc = "0.2"                       # pipe2/splice（CountingPipe 用）
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "fmt"] }
thiserror = "2"
rand = "0.8"                       # 启动 jitter
dotenvy = "0.15"
```

> 不依赖 `realm_core`（黑盒问题，§5.2）、不 fork 任何上游（§5.5）。TLS 后端跟着 kaminari（rustls + ring，§6.4）。内存分配器用系统默认（§6.4）。

### 6.4 构建选项选择（对应 realm 的 Build Options）

realm 的 build options 是其**二进制 crate** 的 feature；我们不构建 realm 二进制，但每一项映射到所依赖 crate 的 feature 或自身 crate 的等价选择。逐项决定如下：

| realm 选项 | 我们的对应物 | 选择 | 理由 |
|---|---|---|---|
| `zero-copy`（已 builtin） | realm_io Linux splice 路径 | **用** | 决策 D1；CountingPipe 走的就是这条路径 |
| `brutal-shutdown` | `realm_io` feature `brutal-shutdown` | **开**（对齐 realm 默认） | 收到任一侧 FIN 即关闭双侧，防劣质对端把半死连接堆积在 `currentConns`/连接表里；依赖 TCP 半关闭的协议（SSH 等，经此中转极少见）会被提前切断——已知取舍；计费不受影响（字节在 splice 写入点已计） |
| `transport` | `kaminari` features `tls+mix` | **开** | 决策 D2（ws 二期随 wss 开） |
| `transport-tls-ring` / `transport-tls-awslc` | kaminari feature `tls-ring` vs `tls-awslc` | **ring** | aws-lc 构建要 cmake（交叉编译/静态 musl 构建的痛点），ring 只需 cc；握手性能差距对本规模无感（每连接一次 ECDHE，ring 每秒数千次握手）；与 reqwest 控制面的 rustls 后端一致，指纹面同族 |
| `balance` | 直接依赖 `realm_lb` | **开** | 决策 D6（realm 二进制的这个 feature 只是往 realm_core 里接线，我们直接接） |
| `hook` | `realm_hook` | **不用** | 附录 E 分析（一期不接；未来等效能力走配置化首包门禁） |
| `proxy`（proxy-protocol） | — | **不用** | 目标是外部业务服务，无 haproxy 类前置；若未来某类目标在 LB 后需要透传客户端真实 IP，作为 per-rule 可选字段再加（kaminari 生态现成） |
| `multi-thread` | 自建 tokio runtime：`multi_thread`，worker = CPU 核数 | **开** | 标准 IO 密集型选择；realm 默认构建亦如此 |
| `batched-udp` | — | **暂不用** | UDP 转发是二期（O1），届时随 UDP 一起开 |
| `jemalloc` / `mi-malloc` / `page-alloc` | 全局分配器 | **系统默认** | splice 热路径**零堆分配**（管道是内核 fd，不是内存缓冲；仅 TLS 腿每连接 2 个 Vec），分配器换血收益存疑；先用默认，profile 后若碎片/延迟敏感再换（一行改动：`#[global_allocator]`） |
| `udp` / `trust-dns`（已 builtin）、`tfo`（已废弃） | — | 无需选择 | 上游已内建/废弃 |

一句话总结：**跟随 realm 默认构建的能力面（零拷贝、brutal-shutdown、multi-thread、transport、balance），TLS 后端选 ring，分配器用系统默认，不接 hook/proxy，UDP 系选项随二期。**

---

## 7. Server 端配套改动（零表结构变更）

### 7.1 渲染器替换（`db/repo.ts`）

`aggregateNodeConfig` 的**数据聚合与闸门部分全部保留**（`getChainsForNode` / `getTunnelsByIds` / `getRulesForTunnels` + `applyRuleQuotas`（配额硬停剔除规则）+ `ensureTlsMaterial` / `normalizeTunnelMode`），仅把最终序列化从 `NodeConfigData`（gost 形态）替换为 `RealmNodeConfig`：

- `recomputeNodeConfig` 内部改为产出 realm 形态 JSON 写入 `node_configs.config_json`（表结构不变，内容形态切换）；
- payload 携带判别字段 `"agent":"realm"`；
- 版本比对/单调递增/未变更不 bump 逻辑复用：切换后首次重算内容必然变化 → 全量 bump + 推送。

### 7.2 共享 schema（`packages/shared`）

新增 zod schema + 类型（web/server 共用）：

```ts
export const realmNodeConfigSchema = z.object({
  agent: z.literal("realm"),
  node: z.object({ id: z.number(), name: z.string() }),
  services: z.array(realmServiceSchema),
  tls_material: tlsMaterialSchema.optional(),   // 仅当存在 TLS 服务
});
export const realmServiceSchema = z.object({
  name: z.string(),                             // service-{ruleId}
  listen_host: z.string(),                      // "0.0.0.0"
  listen_port: z.number().int().min(1).max(65535),
  target_host: z.string(),                      // IP 或域名（域名按连接重解析）
  target_port: z.number().int().min(1).max(65535),
  extra_targets: z.array(z.object({             // 多出口候选（LB，决策 D6）
    host: z.string(), port: z.number().int().min(1).max(65535),
  })).optional(),
  balance: z.enum(["roundrobin", "iphash"]).optional(),  // 有 extra_targets 时生效；缺省 = roundrobin
  tls_side: z.enum(["listen", "connect"]).optional(),   // listen=本服务 TLS 服务端（出口腿）；connect=拨号侧 TLS（入口腿）
  alpn: z.array(z.string()).optional(),         // kaminari 客户端 alpn 选项（一期可不设）
  connect_timeout_s: z.number().optional(),     // 默认 5（realm 默认）
});
```

`AgentConfigResponse.config` 类型改为 `RealmNodeConfig`（gost 形态类型随 Go agent 删除；`NodeConfigData` 里仍被聚合复用的实体类型保留）。

### 7.3 存量语义退役（不改表，改代码路径）

| 列/数据 | 处置 |
|---|---|
| `tunnels.forward_mode` | 列保留、语义退役：渲染器不读它，所有隧道按 raw 端口对语义渲染；`normalizeTunnelMode` 改为恒归一 raw；admin 写入接口不再接受 relay 值（400 + 提示）；面板移除该选择器。存量 relay 行自动按 raw 渲染（Q2） |
| `tunnels.relay_auth_user/pass` | 列保留、休眠：不再调用 `ensureTunnelRelayAuth`，不进 payload（无协议层可挂认证） |
| `tunnels.tls_enabled` + out 链 `transport` | transport ∈ {raw, tls}：`tls` → kaminari TLS 腿；`raw` → 明文；**其余（ws/wss/grpc/mtls/mwss）→ 聚合期降级为明文并告警**（写入校验同时拒绝新值）；`TLS_LINK_TRANSPORTS` 集合改写为 `{tls}` |
| `chains.strategy` | 列本就为 LB 预留（default 'round'），**真实生效**（决策 D6）：见 §7.4 |
| 多跳隧道（存在 `chain` 类型链） | 渲染器跳过该隧道的全部服务（Q4 防御性保留）；admin 写入拒绝新增 `chain` 链（400）；`validateProjectedShape` 相应收紧 |
| `relay_rules.exit_port` | 语义不变（raw 专用 0=自动分配）——所有两节点隧道都是 raw，公式沿用且由 server 算好显式下发（§7.4） |
| `node_configs` 存量快照 | 切换后首次重算覆盖为 realm 形态；agent 重启版本归零全量拉取，无兼容问题 |

### 7.4 渲染规则（server 端一次算清，agent 不做推导）

| 形态 | 节点角色 | 生成服务 | 说明 |
|---|---|---|---|
| 单节点隧道（仅一条 `in` 链） | 该节点 | `service-{ruleId}`：`listen_port → targets` | 直转 |
| 两节点（in + out） | 入口节点 | `service-{ruleId}`：`listen_port → exit.address:exit_port'`，TLS 时 `tls_side:"connect"` + `alpn` | `exit_port'` = 规则 `exit_port`，为 0 时用**该出口节点**端口段算：`start + (rule_id*31 + exit_node_id) % range`（公式沿用，server 对每个出口分别算好显式下发） |
| 两节点（in + out） | 出口节点 | `service-{ruleId}`：`exit_port' → targets`，TLS 时 `tls_side:"listen"` | 同名服务 |
| **多出口（in + N×out，决策 D6）** | 入口节点 | 主出口为 `target_host/port`，其余出口为 `extra_targets[]`；`balance` 由 in 链 `strategy` 映射：`""`/`round` → roundrobin（缺省），`iphash` → iphash | 权重无表字段，全部等权（realm_lb `Balancer::new(strategy, &等权)`）；LB 选路在入口按连接进行（iphash 以客户端 IP 为键粘滞） |
| **多出口（in + N×out）** | 每个出口节点 | 各自渲染自己的 `service-{ruleId}`（端口公式用各自 node_id，互不冲突） | 每连接只走一个出口，无重复计费（§13） |
| TLS 材料 | — | 任一服务带 `tls_side` → payload 附 `tls_material` | 一期实际使用 `server_cert/server_key/sni`；`ca_cert/client_*` 照发（kaminari 暂不消费，未来启用 mTLS 时零改动下发侧） |

约束：**TLS 隧道保持单出口**（现有 `validateProjectedShape` 对 TLS 隧道重复 out 链本就拒绝，不改）——多出口 LB 隧道一期限明文；放开属二期验证项（技术上门户证书同套，入口 MixConnect 可连任意出口）。

其他规则沿用：

- 配额硬停/禁用用户/无订阅：`applyRuleQuotas` 剔除的规则不进 services；
- `limit`（限速限流）与 `quota` 不进 payload；
- 无隧道的规则天然不进任何节点配置；
- rule 的 `targets` 是服务端解析好的 `host:port`（含 endpoint 同步），agent 不做 join。

### 7.5 计费闸门口径（Q3，代码改动）

`services/traffic.ts` 的 `nodeRuleTunnels`：OUT 链从"仅 raw 模式计入"改为**恒计入**（IN 链不变，本就恒计入）。效果：所有两节点隧道两腿入账（与 raw 模式既有口径一致）；`service-t{tunnelId}` 共享出口样本自然绝迹。

### 7.6 admin 面板（`apps/web`）

- 隧道表单：移除转发模式选择器（固定 raw 语义）；TLS 启用时传输选项收敛为 `{tls}`；
- 链表单：禁止创建 `chain` 类型中链；多 out 链 = 出口候选集（现有交互即可表达——一条隧道加多条 out 链；strategy 字段沿用 `chains.strategy`，选项收敛为 `round`/`iphash`）；
- 节点/规则/用户/健康页面零改动（数据同源）。

### 7.7 **零改动清单**（明确不动，回归时按此验收）

表结构（无 migration）、`routes/agent.ts`（三个端点）、`middleware/nodeAuth`、`do/nodePush.ts`、`services/notify`、`services/traffic.ts` 的 ingest/差值/状态写回逻辑（仅 §7.5 闸门口径一处）、`services/quota.ts`、`services/tls.ts`（签发与轮换策略全套）、cron、`traffic_hourly`/`traffic_counters`/`service_health`/`gost_stats`/`node_configs` 表。

---

## 8. 配置模型与示例

入口节点（两节点 TLS 隧道，rule 42，listen 16556，出口 hk-2 的 exit_port' 26556，transport tls）：

```jsonc
// GET /api/agent/config → 200
{
  "version": 1758912346,
  "config": {
    "agent": "realm",
    "node": { "id": 1, "name": "cn-entry-1" },
    "services": [
      {
        "name": "service-42",
        "listen_host": "0.0.0.0",
        "listen_port": 16556,
        "target_host": "203.0.113.20",        // 出口节点 address
        "target_port": 26556,
        "tls_side": "connect",
        "connect_timeout_s": 5
      }
    ],
    "tls_material": {
      "sni": "relay.example.com",
      "ca_cert": "-----BEGIN CERTIFICATE-----…",
      "server_cert": "…", "server_key": "…",
      "client_cert": "…", "client_key": "…"
    }
  }
}
```

出口节点同一规则：

```jsonc
{
  "services": [
    {
      "name": "service-42",
      "listen_host": "0.0.0.0",
      "listen_port": 26556,
      "target_host": "web.example.org",      // 规则 targets（可为域名）
      "target_port": 443,
      "tls_side": "listen",
      "connect_timeout_s": 5
    }
  ],
  "tls_material": { /* 同一套 */ }
}
```

多出口 LB 示例（明文隧道，in.strategy=iphash，出口 hk-2/hk-3/sg-1，入口视角）见附录 B 完整示例。

要点：

- 两侧服务同名 `service-42` → 计费归因、状态写回、重启指令全部沿用（restart 广播到所有相关节点，各自重建自己的同名服务）；
- 单节点直转就是把 target 直接指到规则 targets，无 tls_side/extra_targets。

---

## 9. Agent 模块设计

### 9.1 `main.rs` / `agentcfg.rs`

- 启动序：加载 env → 初始化 tracing（`DEBUG=true` 提升 level）→ `store::load()` 离线引导 → 起 `Supervisor` → 起 loop（含 WS/flush 任务）→ 等信号。
- 信号处理：SIGTERM/SIGINT → 停 WS → **final stats flush**（带 health 全量快照）→ 停 accept 循环（进程退出时既有连接随进程结束——与 Go agent 一致）。
- `--version` 打印构建版本（构建注入 `TYZ_VERSION`，默认 `dev`）；启动日志带版本。
- 环境变量与 Go 版**同名同义**（附录 A）；`GOST_API_ADDR` 废弃（忽略并告警一次）。

### 9.2 `cp::http.rs`

- `fetch_config(version) -> Changed(Resp) | NotModified | Err`：30s 超时、8MiB 响应上限、`?version=` 拼接、Bearer 头；非 200/304 记状态码+截断 body（512B）。
- `upload_stats(samples, health)`：空 `Vec` 序列化为 `[]`；分块（≤20 样本/批）由 loop 侧驱动，本函数只发一批；失败返回错误让上层按"裁剪已成功前缀"重试。

### 9.3 `cp::ws.rs`（状态机，参数逐项对齐 Go 版）

| 参数 | 值 | 说明 |
|---|---|---|
| 重连退避 | 1s 起，指数 ×2，上限 60s | WS 模式失败后 |
| 降级阈值 | 60s 滑动窗 ≥3 次失败 | → poll 模式，触发一次立即拉取 |
| 回升探测 | 每 `WS_PROBE_INTERVAL_MS`（默认 60s）一次，固定间隔不指数 | 成功 → 回 WS 模式 + 立即拉取 |
| ping | 文本 `"ping"`，每 `WS_PING_INTERVAL_MS`（默认 60s，**钳制 < 90s**） | DO 边缘自动回 `"pong"`；读侧空闲看门狗 = 2×ping 间隔，超时按连接失败处理 |
| 连接建立 | 每次成功（重）连接触发 `OnConnected` → 立即拉取 | 弥补断线窗口丢失的 config_changed 广播 |
| 关停 | 发 close 帧后退出任务 | — |

- `WS_ENABLED=false` → 纯 HTTP 轮询。
- 消息处理：`config_changed` → `Wake()`；`restart_service` → `Supervisor::restart(name)`（不拉取，用本地最后期望配置）。

### 9.4 `loop.rs`（主循环）

- 节奏：WS 健康 → 5 分钟安全网轮询；WS 降级 → `POLL_INTERVAL_MS`（默认 10s）；失败退避 ×2 上限 5 分钟 + jitter；成功后退避清零。
- 收到 200：`certs::ensure(&material)`（先落盘）→ `translate()` → `Supervisor::apply(desired)` → 全部成功才采纳版本 + `store::save()`；部分失败同样记录期望态但版本不采纳，下轮重试只补失败服务。
- 收到 304：无事。
- flush 任务独立：启动 sleep 随机相位，之后固定间隔；组装双层样本 + health 全量快照，按 20/批上传，部分失败裁剪重试；关停时同步 final flush。
- **形态守卫**：payload 无 `"agent":"realm"` 判别字段 → 记错误、不应用、版本不采纳（切换期兜底，防误吃旧形态）。

### 9.5 `translate.rs`

- `RealmNodeConfig → Vec<DesiredService>`：校验（端口范围、name 格式、`tls_side` 与 `tls_material` 一致性、`extra_targets` 与 `balance` 组合合法性）；按字典序稳定排序（diff 确定性）。

### 9.6 `runtime/mod.rs`（Supervisor —— 对位 gostapply）

状态：`running: HashMap<name, ServiceHandle>`、`last: Vec<DesiredService>`（最后一次**期望**态，含失败项）、健康快照缓存。

`apply(desired)`：

1. 与 `last` 逐服务深比较；
2. 删除：不在 desired 中的服务 → 关 listener（连接处置见 §10）；
3. 新增/变更：先构建（TLS 服务读证书文件构建 kaminari conf；LB 服务构建 `Balancer`；bind 失败 → 该服务记 `apply_failed`，继续下一个）；变更服务先起新 listener 成功再关旧的；
4. 写回健康快照；任一失败 → 返回聚合错误（loop 不采纳版本）；
5. `last = desired`（即使有失败项——重试只补失败项，对齐 gostapply 的 `a.last` 语义）。

`restart(name)`：只对该服务——关 listener + **主动断开其全部活跃连接** + 用 `last` 重建；不存在则 no-op。

`tls_material_changed`（来自 `certs::ensure`）：TLS 服务即使结构未变也强制重建并断开其连接（kaminari 的 rustls config 内嵌证书材料，不重建就一直用旧证书）。

`shutdown()`：关全部 listener。

健康快照：`running`（accept 循环存活）/ `apply_failed`（bind/构建失败，error 填原因如 `bind 0.0.0.0:26556: AddrInUse`）/ `failed`（accept 循环致命退出）；快照覆盖 `last` 全部服务名（含失败项）→ server 据此写规则状态为 error，面板可见。

### 9.7 数据面（`service.rs` + `net.rs` + `zero.rs` + `tlsconf.rs`）

单服务结构：

```
ServiceHandle {
  name, listen_addr,
  targets: Vec<Target>,            // [主目标] 或 [主, extra…]，元素含 host/port/tls
  balancer: Option<Balancer>,      // realm_lb；None = 恒主目标
  tls: Option<TlsRole>,            // listen = kaminari MixAccept；connect = MixConnect
  listener: TcpListener,
  conn_registry: HashMap<conn_id, ConnHandle>,   // 供 restart 断流
  stats: Arc<ServiceStats>,        // 原子累计器（§9.8）
  cancel: CancellationToken,       // accept 循环停止位
}
```

accept 循环（每服务一个 task，**bind 失败返回错误而非 panic**）：

```
loop {
  (sock, peer) = listener.accept().await?;
  stats.total_conns++; stats.cur_conns++;
  spawn(handle_conn(sock, peer, targets, balancer, stats, conn_registry))
}
```

`handle_conn`（逐语义对位 realm 的 `connect_and_relay`；决策 D5：不设任何 socket 选项）：

1. **LB 选路（可选）**：`balancer.next(BalanceCtx { src_ip: &peer.ip() })` → `Token(0)` = 主目标，`Token(i)` = `extra_targets[i-1]`——与 realm 的 `middle.rs` 选路语义一致（iphash 按客户端 IP 粘滞、roundrobin 等权轮转）；
2. **拨号**：明文 → `TcpStream::connect((host, port))`（域名按连接重解析，系统解析器）；TLS → 先裸连再 `MixConnect::connect(stream)` 握手（`tls;sni=<domain>;insecure`，可选 alpn）；连接超时 `connect_timeout_s`（默认 5s）；
3. 出口 TLS 腿：accept 后 `MixAccept::accept(stream)`（`tls;cert=certs/server.pem;key=certs/server.pem`，平台材料落盘路径）；
4. **双向拷贝分派（零拷贝的核心）**：

```rust
// 明文腿：CountingPipe —— 自己的 AsyncIOBuf 实现，splice 零拷贝 + 写侧原子计数
struct CountingPipe { rd: RawFd, wr: RawFd, tx: Arc<AtomicU64> }   // tx = pipe→socket 方向字节
impl<SR, SW> AsyncIOBuf for CopyBuffer<CountingPipe, SR, SW>
where SR: AsyncRawIO + …, SW: AsyncRawIO + … {
    fn poll_read_buf(..) = stream.poll_read_raw(splice(stream_fd → self.buf.wr))
    fn poll_write_buf(..) = {
        let r = stream.poll_write_raw(splice(self.buf.rd → stream_fd));
        if let Ready(Ok(n)) = &r { self.buf.tx.fetch_add(*n as u64, Relaxed); }   // ← 计数点
        r
    }
}
// bidi_copy_buf(client, target, CopyBuffer::new(pipe_c2t), CopyBuffer::new(pipe_t2c))
// —— 与 realm_io::bidi_zero_copy 同一条 splice 路径，只是缓冲类型换成计数版

// TLS 腿：StatStream 包装 + 用户态拷贝（realm 自身在 transport 模式下同样用户态）
let target = StatStream::new(tls_stream, tx_counter);   // 写入 target 的字节 = upload
let client = StatStream::new(plain_sock, rx_counter);   // 写回 client 的字节 = download
bidi_copy_buf(client, target, CopyBuffer::new(vec![0; buf_size()]), …)
```

5. 连接结束（任一方向 EOF/错误）：`cur_conns--`、连接出表、`errs` 按需累计；restart 断流通过 `ConnHandle` 关闭 socket。

**与 realm wire 行为的对齐点**：splice 零拷贝路径逐字节同源（同一 `bidi_copy_buf` 引擎、同一 `poll_read_raw/poll_write_raw`、同管道尺寸 16×0x1000）；LB 选路同 `realm_lb` 同语义；断连语义跟随 `bidi_copy_buf` + `brutal-shutdown`（任一侧 FIN 即关双侧，对齐 realm 默认构建，§6.4）。

### 9.8 `stats.rs`

计数器注册表（进程生命周期内单调累计，重启归零——server 端有计数器回退=全量计的容错，方向安全）：

```
Key = (service, client_ip)      // client_ip="" 为服务级
Val = { total_conns, cur_conns, in_bytes, out_bytes, errs }  // 全 AtomicU64
```

- 连接 accept：服务级与服务×客户端两个 key 同步 `total_conns++/cur_conns++`；字节计数在拷贝路径原子累加（双向两个 key 同步加）；
- flush 时对每个 key 生成一条样本（原子值快照）→ 发送缓冲；缓冲合并：同 key 覆盖旧值但保留 `currentConns` 窗口峰值；上限 1000 drop-oldest；
- 上传顺序：先服务级样本（账本依赖），再明细；每批 ≤20；
- 计数点 = `splice(pipe→sock)` / `poll_write` 成功字节数 = 已交付内核向对端发送的字节 ≈ 计费口径（与 GOST observer 的口径差异可忽略）。

### 9.9 `certs.rs` / `store.rs`

- `certs.rs`：PEM 写 `certs/{ca,server,server_key,client,client_key}.pem`（tmp+fsync+rename，0700/0600，不变跳过）；任一变更返回 `changed=true`（驱动 TLS 强制重建）。kaminari 服务端 conf 引用 `server.pem/server_key.pem` 文件路径。在 translate/apply 之前执行。
- `store.rs`：`last-config.json`（`{version, config}` 原样序列化），原子写；启动重放：解析失败→告警跳过（Go 版缓存的 gost 形态自然走这条路径，全量重拉）；成功 → translate+apply + 版本基线。

### 9.10 可观测性

- tracing 事件面：startup（版本/env 摘要）、config applied（版本/服务数/新增/删除/失败）、apply_failed（服务/原因）、ws mode 切换、flush 结果、重启指令、TLS 材料变更、shutdown；
- 对齐 Go 版"只记 failed↔recovered 状态迁移"的健康日志策略；
- 日志永不输出 token/PEM。

---

## 10. Apply 语义与连接处置表

| 变更字段 | 处置 | 既有连接 |
|---|---|---|
| 新增服务 | bind + accept 循环 | — |
| 删除服务（规则移除/配额硬停） | 关 listener | **保留至自然关闭**（对齐"quota 停新不断旧"哲学） |
| 目标地址/端口/extra_targets/balance 变更 | 新 listener 就绪后热替换（新连接按新目标集分流） | 保留（旧连接到原出口跑完） |
| 监听端口变更 | 同上 | 保留 |
| TLS 开关/材料变更 | 强制重建 + **断开该服务连接** | 断开（rustls config 内嵌材料，握手期产物） |
| 手动重启指令 | 关 listener + **断开全部连接** + 重建 | 断开（操作员显式动作） |
| bind 失败（端口冲突等） | 该服务 `apply_failed`，其余照常；版本不采纳，下轮重试 | 该服务旧连接（若有）保留 |

> 与 gostapply 的差异（附录 C）：配置变更**不再默认断流**——透明转发没有必须断流的变更点；需要断流的两个场景（TLS 轮换、手动重启）有显式路径。

---

## 11. TLS 链路与安全设计（决策 D2/D4 落地）

### 11.1 kaminari TLS（复用 realm 的库）

- **出口腿（listen 侧）**：`MixAccept` + `TlsServerConf { cert: certs/server.pem, key: certs/server_key.pem }`（`tls;cert=…;key=…`，与 realm 二进制同参）；服务端不验证客户端、不锁 SNI、**不限来源 IP**（决策 D4）；
- **入口腿（connect 侧）**：`MixConnect` + `TlsClientConf { sni: <tls_domain>, insecure: true, alpn: 可选 }`——kaminari 客户端无自定义 CA 选项，平台 CA 自签 → 只能 `insecure`（加密不验证，Q1 知情项）；
- TLS 1.3（rustls 默认），握手形态 = rustls 生态（与 realm+tls 完全一致，§12）；
- 证书生命周期沿用 server 端 `services/tls.ts` 全套（域名校验/档案配置/轮换/到期重签）；`tls_material` 全量下发（一期消费 server 证书；CA/client 材料落盘备用，未来启用 mTLS 只动 agent 一个模块）。

**残余风险（知情接受）**：出口端口（无论明文/TLS）对任意来源开放、TLS 无任何一端验证。现有防线只剩端口隐蔽（高位随机端口对）与目标侧自身的访问控制。恢复杠杆（二期，均只动渲染器 + agent 一个模块）：下发 `allow_from` 准入（accept 后一行检查）、kaminari 换 tokio-rustls 恢复 mTLS（材料已就位）。

### 11.2 密钥与日志纪律

- `NODE_TOKEN` 只进 HTTP 头与内存；PEM 只进 `certs/`（0600）与 `last-config.json`（0600）；token 轮转流程不变；
- 日志/错误消息不含 PEM、token；无本地管理端口。

---

## 12. 流量形态与抗封锁对比

| 维度 | 现状（GOST） | 重构后（Realm 语义） |
|---|---|---|
| 中转协议 | relay 协议（自有头部，目的地址带内传输）或 raw | 无协议：L4 双向拷贝，无任何自有字节 |
| IO 路径 | GOST 用户态 | **Linux splice 零拷贝**（realm 同源引擎） |
| TLS 栈 | Go crypto/tls（ClientHello/扩展顺序有 Go 指纹） | rustls（kaminari，ring/aws-lc 后端）：与整个 Rust web 生态共享指纹面 |
| 出口端口形态 | relay 模式：N 规则共享 1 个出口 listener | 每规则独立端口对，连接彼此独立 |
| observer 行为 | GOST 内部 ~5s 周期采样 | 无（计量在数据面内联，无额外网络行为） |
| 二进制特征 | 内嵌整个 GOST 运行时（Go 二进制，符号/字符串特征明显） | 纯 Rust 单二进制（~几 MB，strip 后无 GOST 痕迹） |

补充工程措施：端口维持高位随机端口对（既有 `ports` 范围分配）；日志默认 warn 级别；不做协议混淆、不做探测对抗——形态本身就是普通转发流量。

---

## 13. 配额与计费影响

- 账本与归因机制零变化（服务级样本差值 + `nodeRuleTunnels` 闸门 + `rate` 折算 + 多节点求和）；闸门口径按 §7.5 调整后，**所有两节点隧道两腿入账**，relay 模式"出口腿无法按规则归因"的低估问题整体消失；
- **多出口 LB 的计费**：每连接只走一个出口；每个出口节点各自上报 `service-{ruleId}` 样本，ingest 按节点求和 → 多出口流量被正确累计、无重复计费（同一字节只经过一个出口）；
- 本地配额闸门消失的补偿：只有服务端硬停（推送延迟 = 配额变更 recompute 的 defer 时延 + WS 推送 + 拉取，通常秒级；最坏 = 每日 cron sweep）。二期后备：agent 已有每服务计数，accept 时本地拒连是纯本地逻辑（~50 行）；
- 限速限流一期忽略；二期如做：令牌桶插在 `AsyncIOBuf` 的 `poll_write_buf` / StatStream 包装处即可（位置已预留，不影响 splice 主路径——限速只对需要限速的服务启用，未启用的服务保持纯 splice）。

---

## 14. 切换流程（无共存窗口，决策 D3 + Q5 = 整体切换）

选定方案 A，一次到位，**不做任何过渡形态**（不发 Go agent 终版补丁）：

1. 停机窗口开始：停全部 Go agent（数据面中断开始）；
2. 升级 server（realm 渲染器 + §7 全部改动）；
3. 触发全量重算（逐节点 `POST /nodes/:id/recompute` 或等价 sweep）；
4. 逐节点启动 rust agent（拉取 realm 配置、起服务）→ 该节点恢复；验证：健康页服务全部 running、规则状态 running、打流后 `traffic_hourly` 出账、手动重启断流生效、多出口隧道分流正确；
5. 全量完成后：删除 `apps/agent` 与 gost 资产（golden 测试、`register.go` 等）；`test:agent`/`dev:agent` 指向 rust；AGENTS.md 改写 agent 章节。

执行要点：

- 窗口时长 ≈ 停机 + server 发布 + 逐节点拉起，分钟级；staging 先全流程演练（含回滚）；
- **顺序不可颠倒**：必须先停全部 Go agent 再升级 server。反序时旧 agent 会把 realm 形态配置用 Go json 宽松解码成空配置（未知字段忽略、rules 为空）→ 渲染空配置 → 清空全部服务；
- 窗口内升级完成的 server 上避免无关管理写与 cron 窗口（节点全部停机时无害，但保持窗口干净）；
- **回滚**：停 rust agent → git revert server（渲染器回 gost 形态）→ 全量重算 → 起 Go agent。配置形态在 `node_configs` 快照层切换，无数据残留问题。

---

## 15. 测试方案

| 层 | 内容 |
|---|---|
| 单元（rust） | `translate` golden（单节点/两节点/TLS/多出口 LB/配额剔除/畸形拒绝/形态守卫）；`stats` 合并（同 key 覆盖+峰值保留）、1000 上限、20/批切分、部分失败裁剪；`cp::http` 304/200/4xx/超大体；`certs` 原子写/不变跳过/changed 标志 |
| 零拷贝计数（rust，重点） | `CountingPipe`：与 `bidi_zero_copy` 输出比对（同流量下计数相等）；splice 路径验证（strace 确认无 read/write 用户态拷贝）；方向正确性（upload/download 不颠倒）；EOF/半关闭/错误路径 |
| 状态机（rust） | `cp::ws`：本地 WS server 驱动 3/60s 降级 → 探测回升 → config_changed 送达；文本 ping 与看门狗 |
| 数据面（rust） | 回环转发：明文直连、kaminari TLS（自签测试证书，`insecure` 客户端）、目标域名、restart 断流、apply 部分失败（占端口模拟冲突）→ apply_failed、优雅关闭 |
| 负载均衡（rust） | roundrobin 多连接均匀分布到主/extra 目标；iphash 同客户端粘滞、不同客户端分散；单出口服务无 balancer 直连主目标；LB 目标集热更新（新连接生效、旧连接保留） |
| server（bun:test） | `buildRealmNodeConfig` golden；存量语义退役矩阵（relay→raw 渲染、非 tls 传输降级、多跳跳过）；多出口渲染（extra_targets/balance 映射、strategy ∈ {round, iphash}）；`nodeRuleTunnels` 新口径；stats ingest 对 rust 样本（`[]` 空数组形态）兼容 |
| 基准 | 与 realm v2.9.5 二进制同机对比吞吐/CPU（iperf3 经由中继，明文腿）——验收 G4 零拷贝要求；小包延迟对比评估 Nagle 影响（O5） |
| e2e | `e2e-local.sh` 重写：realm 形态 seed（单节点直转、两节点 raw、两节点 TLS、三出口 LB 明文隧道），rust agent + 本地目标断言可通 + TLS listener 明文探测行为 + LB 分流断言；`test-ws-push.ts` 复用（协议未变） |
| 演练 | staging 按 §14 全流程（含回滚）走一遍 |

---

## 16. 里程碑与工作量估算

| 阶段 | 内容 | 产出 | 估算 |
|---|---|---|---|
| M0 方案定稿 | 本文档（已完成全部决策） | — | — |
| M1 server 配套 | realm 渲染器替换、存量语义退役、闸门口径、写入校验、面板收敛、server 单测 | 可下发 realm 配置 | 2~3 人日 |
| M2 agent 骨架 | crate 搭建、agentcfg/cp::http/store/loop（形态守卫，配置只落盘不应用）、ws 状态机 + 单测 | 配置同步闭环（`test-ws-push` 通过） | 3~4 人日 |
| M3 数据面 + 统计 | `CountingPipe` 零拷贝计数、kaminari TLS、realm_lb 选路、受管 accept/apply/restart/健康、stats 上报、certs、基准测试 | e2e 明文/TLS/LB 转发 + 出账 + 性能达标 | 4~5 人日 |
| M4 切换 | 演练、整体切换、清理 Go agent 与 gost 资产 | 全量 realm 数据面 | 2~3 人日 |
| 合计 | | | **11~15 人日** |

---

## 17. 风险与开放问题

| # | 风险/问题 | 评估与对策 |
|---|---|---|
| R1 | **TLS 链路无认证且无准入**（D2+D4）：入口 `insecure`、出口不验客户端、不锁 SNI、不限来源 IP。出口端口可被任意来源使用（发现端口即用） | 残余防线：高位随机端口对（不公开）+ 目标侧自身访问控制。恢复杠杆已预留：`allow_from` 渲染开关 + agent 一行检查；mTLS 材料已全量下发，换 tokio-rustls 即恢复（只动 agent TLS 模块） |
| R2 | `CountingPipe` 依赖 `realm_io` 公开 trait 面（`AsyncIOBuf`/`AsyncRawIO`/`CopyBuffer`） | 接口极小且稳定（realm 性能根基，上游不会轻动）；万一 breaking：锁版本 + ~150 行复制该实现进自身 crate（非 fork 维护负担） |
| R3 | wss 二期 | kaminari 的 ws conf 已公开（`get_ws_conf`，host+path），加特性开关即可 |
| R4 | 配额硬停时延（无本地闸门） | §13 已评估；**I8（2026-08-30）落地分钟级缓解**：stats flush 驱动的硬停清扫把超用窗口缩到一个 flush 周期；后备 = accept 时本地拒连（二期） |
| R5 | 切换期顺序风险（server 先升而节点未换） | 整体切换流程铁律：先停全部 agent 再升 server（§14） |
| R6 | exit_port 自动分配碰撞 | 与现状同性质：bind 失败 → apply_failed → 面板可见 → 人工固定端口；server 渲染期加同节点碰撞预检（M1 顺手做） |
| R7 | 多出口 LB 的出口腿计费叠加 | 每连接只走一个出口，无重复计费（§13）；iphash 粘滞可能造成出口间不均——运营侧用 per-node `rate` 调节 |
| R8 | `realm_lb::Strategy::from(&str)` 遇未知值 panic | 我们不解析字符串：渲染器映射为枚举后下发，agent 侧 `match` 全覆盖 |
| R9 | rustls TLS 指纹与 Go 不同 | 正向收益（§12）；不做主动伪装，保持"普通服务端"定位 |
| R10 | WS 文本 ping 依赖 DO 自动应答 | 契约已核实（`nodePush.ts:29`），rust 侧发 `Message::Text("ping")`；读看门狗兜底 |
| O1 | 开放：UDP 二期引入（realm 全锥 NAT 语义，`network.udp` 字段位已预留） | `AsyncRawIO` 对 UdpSocket 已有实现（realm_io linux/mod.rs），技术无障碍 |
| O2 | 开放：`STATS_FLUSH_INTERVAL_MS` 自适应 | 100 服务 ≈ 200 样本/flush ≈ 10 批，60s 无压力；先不做 |
| O3 | 开放：TLS 隧道多出口放开（现保持单出口，§7.4） | 技术上门户证书同套可行；二期验证后放开 |
| O4 | ~~开放~~ **已决**（§6.4）：`brutal-shutdown` 开启（对齐 realm 默认），任一侧 FIN 即关双侧，防半死连接堆积；依赖 TCP 半关闭的协议会被提前切断——已知取舍 |
| O5 | 开放：Nagle 影响评估（D5 决策不设 NODELAY） | 小包请求/响应交互可能引入 ~40ms 级延迟（Nagle × delayed-ACK），吞吐无影响；压测若敏感，恢复只需拨号后一行 `set_nodelay(true)`（tokio 原生 API，无新依赖） |

---

## 附录 A：环境变量（与 Go 版同名同义）

| 变量 | 默认 | 说明 |
|---|---|---|
| `CONTROL_PLANE_URL` | （必填） | 控制面基址，末尾 `/` 剥离 |
| `NODE_TOKEN` | （必填） | Bearer 令牌 |
| `POLL_INTERVAL_MS` | 10000 | HTTP 轮询间隔（WS 降级时生效） |
| `STATS_FLUSH_INTERVAL_MS` | 60000 | 统计上报间隔（启动相位随机化） |
| `WS_ENABLED` | true | false = 纯 HTTP 轮询 |
| `WS_PROBE_INTERVAL_MS` | 60000 | 降级期间回升探测间隔 |
| `WS_PING_INTERVAL_MS` | 60000 | 文本 ping 间隔（钳制 < 90s） |
| `DEBUG` | false | true = debug 日志（无本地 API） |
| ~~`GOST_API_ADDR`~~ | — | 废弃；存在时告警一次并忽略 |

非法数字值启动即报错退出，不静默回退（对齐 Go 行为）。

## 附录 B：`RealmNodeConfig` 完整示例（多出口 LB + TLS + 单节点直转）

```jsonc
{
  "version": 1758912346,
  "config": {
    "agent": "realm",
    "node": { "id": 1, "name": "cn-entry-1" },
    "services": [
      {
        // 明文隧道，3 出口（in.strategy=iphash）：rule 44
        "name": "service-44",
        "listen_host": "0.0.0.0",
        "listen_port": 16558,
        "target_host": "203.0.113.20",            // 主出口 hk-2
        "target_port": 26558,
        "extra_targets": [
          { "host": "203.0.113.21", "port": 26558 },   // hk-3（公式含各自 node_id，端口各自独立）
          { "host": "198.51.100.30", "port": 26558 }   // sg-1
        ],
        "balance": "iphash",
        "connect_timeout_s": 5
      },
      {
        // 两节点 TLS 隧道：rule 42
        "name": "service-42",
        "listen_host": "0.0.0.0",
        "listen_port": 16556,
        "target_host": "203.0.113.20",
        "target_port": 26556,
        "tls_side": "connect",
        "connect_timeout_s": 5
      },
      {
        // 单节点直转：rule 43
        "name": "service-43",
        "listen_host": "0.0.0.0",
        "listen_port": 16557,
        "target_host": "web.example.org",
        "target_port": 443,
        "connect_timeout_s": 5
      }
    ],
    "tls_material": {
      "sni": "relay.example.com",
      "ca_cert": "-----BEGIN CERTIFICATE-----…",
      "server_cert": "-----BEGIN CERTIFICATE-----…",
      "server_key": "-----BEGIN PRIVATE KEY-----…",
      "client_cert": "-----BEGIN CERTIFICATE-----…",
      "client_key": "-----BEGIN PRIVATE KEY-----…"
    }
  }
}
```

## 附录 C：与 Go agent 的行为差异清单（评审重点）

| 项 | Go/GOST | Rust/Realm | 理由 |
|---|---|---|---|
| 数据面 | 内嵌 GOST 运行时（relay 协议/raw），用户态拷贝 | realm 语义 L4 拷贝，**明文腿 splice 零拷贝** | 本方案核心目标 + 决策 D1 |
| TLS 链路认证 | mTLS + relay auth + admission 三层 | kaminari TLS（仅加密），**无任何验证/准入** | 决策 D2/D4（Q1 知情项） |
| socket 选项 | GOST 内部设置 | 不设置（内核默认，Nagle 开启） | 决策 D5（O5 评估） |
| 负载均衡 | selector 管道存在但每跳/每 forwarder 恒单节点，**实际不可达** | realm_lb 真实多出口分流（roundrobin/iphash） | 决策 D6（`chains.strategy` 落地） |
| 服务变更时既有连接 | 全部断开（close+re-serve） | 保留（§10），显式断流仅 TLS 轮换与手动重启 | 透明转发无必须断流点 |
| 限速/限流/本地配额 | 支持 | 一期不支持（§2/§13） | 明确裁剪 |
| relay 模式共享出口 / 多跳 | 支持 | 不支持（一律 raw 端口对；多跳跳过） | 无协议即无多路复用 |
| 统计粒度 | observer 5s 周期事件 | flush 间隔（60s 默认）快照；字节计数在 splice/写入点实时累计 | 账本只依赖差值；`currentConns` 峰值语义保留 |
| 本地调试 API | DEBUG 时 GOST Web API | 无 | 攻击面收敛 |
| offline 缓存 | `last-config.json` | 同名同机制（payload 形态变更，首启跳过旧缓存全量重拉） | 运维连续性 |

## 附录 D：端口转发功能架构清单（realm 库 vs 自研）

> 本附录回答"转发功能哪些用 realm 的库、哪些自己写"。每一条的来源均已对照上游源码核实（realm v2.9.5 workspace / realm_io 0.5.4 / kaminari 0.14 / realm_lb 0.1）。

### D.1 一条连接的完整生命周期（按步骤标注提供方）

```
客户端                          tyz-agent                              目标/出口
   │                                │                                     │
   │  ① bind listener  [自研] 受管 bind（失败返回 Err，非 realm 的 panic）       │
   │  ② TCP connect                                                     │
   ├──────────────────►│ ③ accept        [自研] 受管 accept 循环           │
   │                   │ ④ LB 选路(可选) [realm_lb] Balancer::next        │
   │                   │    （Token(0)=主目标，Token(i)=extra_targets）    │
   │                   │ ⑤ 拨号          [标准库] TcpStream::connect((host,port))│
   │                   │    （域名按连接重解析；realm_core 的拨号私有不可复用）│
   │                   │ ⑥ TLS 握手(可选) [kaminari] MixAccept/MixConnect  │
   │                   │    （kaminari 就是 realm 的 TLS 栈）              │
   │                   ├──────────────────────────────────────────────────►│
   │                   │ ⑦ 双向拷贝：                                     │
   │                   │   明文腿 = [realm_io] bidi_copy_buf 引擎          │
   │                   │            + [自研] CountingPipe 缓冲             │
   │                   │            （splice 零拷贝 + 原子字节计数）       │
   │                   │   TLS 腿  = [realm_io] 拷贝引擎                   │
   │                   │            + [realm_io] StatStream 计数包装       │
   │                   │            （流本身来自 kaminari）                │
   ├──────────────────►│◄──────────────────────────────────────────────────┤
   │  ⑧ 连接结束        │ [自研] cur_conns--、连接出表、errs 计数；          │
   │                   │       restart 断流句柄回收                        │
```

（决策 D5：不设 NODELAY/keepalive，无对应步骤；决策 D4：无准入检查步骤。）

### D.2 直接使用的 realm 生态库（转发功能的依赖面）

| 用途 | crate / feature | 具体使用的 API | 上游位置（已核实公开） |
|---|---|---|---|
| 双向拷贝状态机 | `realm_io 0.5` | `bidi_copy_buf(a, b, buf1, buf2)`——读/写/冲刷/半关闭/优雅关闭的整个引擎，两条腿共用 | `realm_io/src/bidi_copy.rs` |
| 拷贝缓冲容器与扩展点 | `realm_io 0.5` | `CopyBuffer<B, SR, SW>::new`、trait `AsyncIOBuf`（`poll_read_buf/poll_write_buf/poll_flush_buf`）——CountingPipe 的挂接点 | `realm_io/src/buf.rs:41-51`（无 sealed） |
| 裸 fd IO 就绪调度 | `realm_io 0.5`（linux） | `AsyncRawIO`（含 `TcpStream` 实现）：`poll_read_raw/poll_write_raw`——把 splice 系统调用挂到 tokio readiness 循环 | `realm_io/src/linux/mod.rs` |
| TLS 腿计数包装 | `realm_io 0.5` feature `statistic` | `statistic::StatStream::new(io, stat)`——写侧计数（`poll_write(_vectored)` 成功即累加） | `realm_io/src/statistic.rs` |
| TLS 腿缓冲尺寸 | `realm_io 0.5` | `mem_copy::buf_size()`——用户态拷贝缓冲大小与 realm 一致 | `realm_io/src/mem_copy.rs` |
| TLS 握手与 TLS 流 | `kaminari 0.14` features `tls,mix` | `mix::{MixAccept, MixConnect, MixServerConf, MixClientConf}`（`new_shared`）；`tls::{TlsServerConf(cert,key), TlsClientConf(sni,alpn,insecure)}`（字段公开）；`opt::get_tls_server_conf/get_tls_client_conf`（选项串解析，与 realm 二进制同参）；`AsyncAccept::accept` / `AsyncConnect::connect`（握手）；rustls 后端（TLS 1.3）。**kaminari 就是 realm 的 TLS 实现，realm_core 的 transport 模块只是转手调用它** | `kaminari/src/{mix,tls,opt}.rs`、`realm_core/src/tcp/transport.rs` |
| 多出口负载均衡 | `realm_lb 0.1` | `Balancer::new(Strategy::{RoundRobin,IpHash}, weights)`、`balancer.next(BalanceCtx { src_ip }) -> Option<Token>`（Token(0)=主目标）；选路语义与 realm `middle.rs` 一致 | `realm_lb/src/{balancer,round_robin,ip_hash}.rs` |

### D.3 自研组件（为什么必须自己写）

| # | 组件 | 内容 | 不用 realm 对应物的理由（源码依据） | 估算 |
|---|---|---|---|---|
| 1 | `zero.rs::CountingPipe` | `pipe2(O_NONBLOCK)` + `F_SETPIPE_SZ` + `splice(SPLICE_F_MOVE\|NONBLOCK)` + `impl AsyncIOBuf for CopyBuffer<CountingPipe,…>`；在 `pipe→sock` 那次 splice 成功后原子累加字节 | `realm_io::Pipe` 是字段私有的 tuple struct，外部拿不到 fd 挂计数；`StatStream` 只包 `AsyncWrite` 流，splice 路径不经过 `poll_write`。**splice 系统调用序列与 realm 的 `zero_copy.rs` 逐行对齐**（同引擎 `bidi_copy_buf`、同 readiness 原语） | ~80 行 |
| 2 | `service.rs` 受管 accept 循环 | bind（失败返回 `Err`）、accept 循环、`CancellationToken` 单服务停止、每服务独立 task、连接注册表 | `realm_core::tcp::run_tcp` 黑盒：bind 失败直接 `panic!`（`tcp/mod.rs:34`）、循环不可停止、无任何回调 | ~120 行 |
| 3 | `net.rs` 拨号编排 | **标准库调用，非自研解析器**（Q6 澄清）：`TcpStream::connect((host, port))` + 连接超时 + LB Token→目标映射 + kaminari 握手调用 | `realm_core` 的 `socket::connect`/hickory 解析器在私有模块不导出；kaminari 只握手不拨号。若要对齐 realm 的 hickory 异步缓存解析，直接依赖 `hickory-resolver` 即可 | ~40 行 |
| 4 | `tlsconf.rs` TLS 装配 | 平台 PEM 落盘路径 → `TlsServerConf{cert,key}` / `TlsClientConf{sni,insecure}` → `MixAccept/MixConnect::new_shared` | realm 的装配代码在其**二进制 crate** 的 conf 层（`realm/src/conf/endpoint.rs::build_transport`，crate 不发布）；按其源码等价实现 | ~60 行 |
| 5 | `runtime/mod.rs` Supervisor | 期望态 diff（增/删/改）、部分失败语义（`apply_failed` + 版本不采纳 + `last` 记录重试）、restart 单服务断流重建、TLS 材料变更强制重建、健康快照 | realm 是静态配置工具，无动态 apply/生命周期概念 | ~250 行 |
| 6 | `stats.rs` 计量聚合 | `(service, client)` 原子累计器、双层样本（服务级+客户端级）、缓冲合并（峰值保留）、1000 上限、20/批分块 | realm 无统计输出（这是选自建路线的直接原因，§5.4） | ~150 行 |

> 合计约 700 行，全部是 realm 作为通用转发工具不提供、平台纳管必须有的部分；它们**不改变**转发语义（数据路径仅 1、3、4 三处参与，且 1 与 realm 实现逐行对齐、3 是标准库一行调用的编排）。

### D.4 从 realm 对齐的常量与行为（抄参数，不抄代码）

| 项 | 取值 | realm 来源 |
|---|---|---|
| 管道容量（CountingPipe 默认） | 16 × 0x1000 | `linux/zero_copy.rs::DF_PIPE_SIZE` |
| 连接超时 | 5s（`connect_timeout_s` 可下发覆盖） | `network.tcp_timeout` 默认 |
| socket 选项 | **不设置**（决策 D5；Nagle 内核默认，O5 评估恢复杠杆） | realm 设 NODELAY/keepalive，我们显式不设 |
| 用户态缓冲（TLS 腿） | `realm_io::buf_size()` | `mem_copy` |
| 关闭语义 | brutal-shutdown 开启（任一侧 FIN 即关双侧，realm 默认构建，§6.4） | realm 默认构建 |
| Endpoint 模型 | `DesiredService` 字段设计蓝本 = `endpoint::{Endpoint, BindOpts, ConnectOpts, RemoteAddr}` | `realm_core/src/endpoint.rs` |
| LB 语义 | Token(0)=主目标 / Token(i)=extra、iphash 以 src_ip 为键 | `realm_core/src/tcp/middle.rs` + `realm_lb` |

### D.5 依赖图（转发功能边界）

```
tyz-agent
├── 数据面（端口转发功能）── 直接依赖 realm 生态
│   ├── realm_io 0.5 [statistic]      拷贝引擎 / 零拷贝原语 / StatStream 计数
│   ├── kaminari 0.14 [tls, mix]      TLS 握手与 TLS 流（rustls 后端，= realm 的 TLS 栈）
│   ├── realm_lb 0.1                   多出口负载均衡
│   └── libc                           pipe2 / splice（CountingPipe）
├── 控制面（与 realm 无关，平台自有协议）
│   ├── reqwest / tokio-tungstenite    config 拉取 / stats 上报 / WS 推送
│   └── serde / serde_json / tracing / thiserror / rand / dotenvy
└── 明确不依赖：
    ├── realm_core     —— 可复用部分只有 70 行黑盒入口 run_tcp（bind panic / 不可停 / 无回调，§5.2），
    │                     其 Endpoint 模型仅作设计参照（D.4）
    ├── realm_hook     —— pre-connect .so 钩子，一期不接（附录 E 分析）
    └── realm 二进制    —— 无热重载、无统计，不作为子进程
```

**版本锁定与升级策略**：`Cargo.lock` 锁死 realm_io/kaminari/realm_lb 精确版本；三者均为叶子小库，上游 breaking 时锁版本继续用，必要时把受影响的 ~150 行实现复制进自研 crate——不存在 fork 维护负担。

### D.6 代码量分布总览

| 部分 | 提供方 | 规模 |
|---|---|---|
| 拷贝引擎 + 零拷贝 + TLS 栈 + TLS 计数包装 + LB 算法 | realm 生态（外部依赖） | 0 行自研（realm_io + kaminari + realm_lb + rustls 全包） |
| 转发功能自研（D.3 的 1~6） | 本项目 | ~700 行 |
| 控制面（cp/loop/translate/model/certs/store/agentcfg/main） | 本项目（与 realm 无关） | ~800 行 |

## 附录 E：realm_hook 现状分析（一期不接，留档）

**它是什么**：realm 的插件式 pre-connect 钩子，运行时 `libloading` 加载一个 `.so`（CLI `-j/--pre-connect-hook <path>`，`realm_hook::pre_conn::load_dylib`），**仅接线在 TCP 接入路径**（`realm_core/src/tcp/hook.rs`；UDP 路径未接线，已核实 `udp/` 无 hook 引用）。需 realm 构建开启 feature `hook`。

**工作机理**（`realm_hook/src/pre_conn.rs`，.so 需导出两个 C 符号）：

1. `realm_first_pkt_len() -> u32`：告诉 realm 需要偷看客户端**首个数据包**的前多少字节（`TcpStream::peek`，不消费）；
2. `realm_decide_remote_idx(extra_count, buf_ptr) -> i32`：拿到首包指针做任意判断，返回值决定——**负数 = 拒绝该连接**（未拨号直接断）、`0` = 默认 remote、`1..n` = `extra_remotes[i-1]`。

**现实用途**（生态里的典型玩法）：

- **内容感知选路**：按首包特征（协议魔数、TLS ClientHello 里的 SNI 等）把连接分到不同后端——比 LB 策略更细一层的路由；
- **防探测门禁**：首包不匹配预期（如约定魔数/密码前缀）就直接 ban——端口扫描器/主动探测器拿到的是 TCP 建连后立刻断开，与"端口没人用"难以区分，是 realm 生态对抗主动探测的主要手段；
- **首包嗅探 + 拒绝**的组合也可以当作简易的"端口共享/协议复用"开关。

**对本项目的评估**：

- 优点：与 LB（`extra_remotes` 选路）天然配合；对抗"出口端口任意来源可用"（R1）恰好是对症的一味药——不匹配首包的连接直接断，把"发现端口即可白嫖"收敛为"带正确首包才能用"；
- 顾虑：① 生产加载外部 .so 的供应链与稳定性风险（谁编译、谁审计、崩溃即进程崩）；② 规则是二进制黑盒，面板不可见不可运营；③ 我们自建 accept 循环后，等效能力**不需要 .so 机制**也能做——peek 首包 + 匹配下发的规则（魔数/长度）约 40 行，作为配置项（如 service 增加 `first_pkt_gate: {len, magic_hex}`）比插件更可控；
- 结论：一期不接；若未来要做防探测门禁，建议走**配置化首包门禁**（agent 内实现），不引入 realm_hook 的动态加载机制。
