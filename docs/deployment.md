# TYZ 生产部署指南

本指南覆盖将 TYZ 平台部署到生产的完整流程：

- **控制面**（`apps/server`，Cloudflare Worker + D1 + Durable Object）：通过 **Workers Builds** 接入 Git 仓库——一次性配置后，**日常发布 = `git push`**；
- **管理面板**（`apps/web`）：随控制面一起部署（构建产物由 Worker Assets 托管，无需单独部署）;
- **节点机 agent**（`apps/agent`，Rust 单二进制、realm 生态数据面）：每台中继机器一个容器（host 网络）。

仓库对公共部署友好：`wrangler.jsonc` **不携带任何账户相关的资源 ID**（D1 由 wrangler 自动资源供给创建并按名称保持绑定），**零 secrets 即可运行**——管理员账号在首次打开面板时经 `/setup` 向导创建（存于数据库），本地无需安装任何工具。

首次部署路线图：

```
第 1 步  部署控制面                         两选一：Fork 后接入（推荐）/ 直连原仓库 + 2 个 secrets
第 2 步  管理面板初始化                     节点 / 隧道 / 规则 / 用户 / 套餐
第 3 步  节点机部署 agent                   docker compose up -d（每台节点机）
```

---

## 1. 部署拓扑

```
┌────────────────────────── Cloudflare ──────────────────────────┐
│  Worker: tyz (Hono)                                           │
│   ├─ /api/admin/* 管理面板 API + 静态托管 (React SPA)             │
│   ├─ /api/agent/* 节点 API（Bearer NODE_TOKEN 认证）              │
│   │            /api/agent/ws WebSocket 推送（NodePushDO）          │
│   ├─ D1: relay_nodes / tunnels / chains / relay_rules /         │
│   │          node_configs / gost_stats / traffic_hourly ...      │
│   └─ Cron: 每日 03:00 UTC（数据清理 / 配额扫描 / TLS 续期）          │
└───────────────▲─────────────────────────────▲──────────────────┘
        WS 推送 + 版本化拉取 GET /api/agent/config │ POST /api/agent/stats（批量统计）
                │ (config_changed → 304 / 200)  │
┌───────────────┴───────────────────────────────┴────────────────┐
│  节点机 ×N（单容器，host 网络）                                     │
│  tyz-agent（Rust，realm 数据面）                                  │
│   ├─ 配置按对象 diff 热更新（进程内 registry）                      │
│   └─ observer 统计 ──► 缓冲 ──► 批量上报                          │
└─────────────────────────────────────────────────────────────────┘
```

部署单元与职责：

| 单元 | 位置 | 职责 |
|---|---|---|
| Worker `tyz` | Cloudflare 边缘 | 面板 API + SPA 托管、agent 配置下发（WS 推送优先）、统计接收、配额/续期巡检 |
| D1 数据库 `tyz` | Cloudflare | 全部业务数据（含计费台账 `traffic_hourly`，永不清理） |
| `NodePushDO`（Durable Object） | 随 Worker | 每节点一个实例，WebSocket 休眠推送 |
| agent 容器 | 每台节点机 | 内嵌 GOST 数据面：监听入口端口、转发/中继流量、执行限速与配额 |

---

## 2. 前置条件

### 2.1 账号与本地工具

| 项 | 要求 |
|---|---|
| Cloudflare 账号 | 免费计划即可运行（D1 / DO / Workers Builds 均可用）；生产环境建议 Workers Paid，避免免费计划的每日请求/构建额度限制 |
| 本机 | 无硬性要求——部署与初始化全程在 Cloudflare 上完成（可选：Bun ≥ 1.2 + 仓库 devDependency 里的 wrangler 用于本地开发与 D1 备份导出） |
| 节点机 | Linux x86_64 或 arm64，Docker Engine + compose 插件 |
| 仓库 | 已推送到 GitHub（Workers Builds 从仓库拉取构建；`bun.lock` 已入库，CI 安装走 frozen 模式） |

### 2.2 网络与端口规划

| 方向 | 端口 | 用途 |
|---|---|---|
| 节点机 → 控制面域名 | 443（出站，HTTPS/WSS） | agent 拉配置、WS 长连接、上报统计 |
| 节点机 ↔ 节点机 | 隧道链路端口（见下） | relay 链路 / raw 模式出口端口 |
| 客户端 → 入口节点 | 各规则 `listen_port` | 用户接入 |
| 管理员 → 控制面域名 | 443 | 管理面板 |

端口自动分配：节点的 `ports` 字段是一个区间（如 `16800-16999`）。创建链路/规则时端口填 `0` 会按确定性公式从该区间分配，**两端独立计算也能得到同一个值**：

- relay 出口端口：`start + (chain_id + node_id) % 范围宽度`
- raw 模式出口端口：`start + (rule_id × 31 + node_id) % 范围宽度`

规划建议：每台节点的区间互不重叠即可完全避免自动分配冲突；区间重叠时自动分配可能撞端口（面板健康页会显示 `apply_failed`），处置方式是给该链路/规则显式指定端口。

---

## 3. 控制面部署

### 3.1 部署通道选择

| 通道 | 适合 | 见 |
|---|---|---|
| **Fork 后接入 Workers Builds**（推荐） | 个人部署者：保留完整 monorepo 副本，可改代码、可 Sync fork 跟进上游更新 | 3.2 |
| **直连原仓库接入 Workers Builds** | 不改代码的自部署 / 维护者自用生产 | 3.3 |

> **为什么不提供 Deploy to Cloudflare 按钮**：实测按钮流程会把仓库克隆成一个**独立的新仓库（不是 GitHub fork）**，后续无法用 Sync fork 跟进上游；且按钮 URL 指向子目录（monorepo 的 Worker 在 `apps/server`）时，克隆出的仓库**只包含该子目录**——`packages/shared` 等 workspace 依赖与前端源码全部丢失，`bun install` 直接报 `Workspace dependency "@tyz/shared" not found`。对 monorepo 不可用，故本项目以 Fork 路径为主。

### 3.2 Fork 后部署（推荐给个人部署者）

适合想长期运行自己的副本、改代码或跟随上游更新的部署者：**Fork → 按需改配置 → Dashboard 连自己的 fork**。

**① Fork 仓库**：GitHub 仓库页右上角 **Fork**（保留默认分支 `master`）。

**② 按需修改自己副本里的配置**（全部可选，不改也能直接部署）：

| 想改什么 | 改哪里 | 说明 |
|---|---|---|
| Worker 名 | 根目录 `wrangler.jsonc` 的 `name`（`tyz`） | Dashboard 里创建的 Worker 名必须与它一致（见 3.3 的告警） |
| D1 数据库名 | 根目录 `wrangler.jsonc` 的 `database_name`（默认 `tyz`） | 首次部署自动创建同名数据库；不需要填任何资源 ID |
| 面板标题等 | `apps/web/` 源码 | 改完随下次部署自动生效 |

**③ 接入 Workers Builds**：**Workers & Pages → Create → Worker → 连接 Git 仓库**，选择**你 fork 的仓库**与 `master` 分支，Worker 名保持 `tyz`（与 `wrangler.jsonc` 的 `name` 一致）。wrangler 配置就在**仓库根目录**，因此 Root directory 与构建变量都用默认，**需要手动填的是以下两项**：

| 设置 | 值 | 说明 |
|---|---|---|
| Build command | `bun run build:web` | 构建面板到 `apps/web/dist`（Worker Assets 托管该目录） |
| Deploy command | `bun run deploy:server` | 部署 + 自动应用 D1 迁移（首次部署自动建库建表） |

> **这两项都不会被自动识别/预填**——自动预填是 Deploy 按钮流程专属；手动连接只做框架探测，monorepo 仓库根探测不到框架，必须手动输入。依赖安装由 Cloudflare 的自动安装步骤在仓库根完成（`bun install`，workspace 正常解析），无需自己装也无需任何构建变量。

**④ 触发部署**：连接保存后即触发首次构建部署——建库、建表全部自动完成，本地无需执行任何命令。

**⑤ 跟进上游更新**：GitHub fork 页面点 **Sync fork**（或 `git pull upstream master && git push`）→ push 自动触发重新部署；迁移随部署命令自动应用，无需本地操作。

部署完成后打开面板地址，按向导创建管理员账号（见 3.4），然后进入第 4 节初始化面板。

### 3.3 手动接入 Workers Builds（直连原仓库）

Workers Builds 的行为：push 到生产分支 → 跑**构建命令**（可选）→ 跑**部署命令**（默认 `npx wrangler deploy`）。**构建/部署命令只能在 Dashboard 配置，`wrangler.jsonc` 里的 `[build]` 块对 CI 不生效**。

在 Cloudflare Dashboard：**Workers & Pages → Create → Worker**，选择**连接 Git 仓库**（而非 Hello World 模板），选择本仓库与生产分支 `master`。

> ⚠️ **Worker 名字必须与 `wrangler.jsonc` 的 `name` 一致：`tyz`**。不一致是接入失败的常见原因（构建报错找不到/名字冲突）。

然后在 Worker 的 **Settings → Build** 按下表配置：

| 设置项 | 值 | 说明 |
|---|---|---|
| Root directory | 默认（仓库根） | wrangler.jsonc 就在仓库根目录，无需设置 |
| Build command | `bun run build:web` | 构建面板到 `apps/web/dist`（Worker Assets 托管该目录）；依赖已由自动安装步骤在根目录装好 |
| Deploy command | `bun run deploy:server` | 部署 + 自动应用 D1 迁移（首次部署自动建库建表，见 3.7）。**Build 与 Deploy 两个命令都不会被自动识别，必须手动输入**（自动预填是 Deploy 按钮流程专属；手动连接只做框架探测，monorepo 仓库根探测不到框架） |
| 非生产分支构建 | 保持关闭 | 本 Worker 含 Durable Object，**不生成预览 URL**，预览版上传（`wrangler versions upload`）没有意义，徒增版本噪音 |

其他事实（无需操作，知道即可）：

- 构建镜像**预装 Bun 1.2.15**（可用构建变量 `BUN_VERSION` 覆盖版本），`bun install` / `bun run` 直接可用；`CI=true` 环境下 bun 默认 frozen-lockfile，与已入库的 `bun.lock` 匹配。自动依赖安装在仓库根跑 `bun install`，workspace 正常解析。
- 首次部署会自动生效 `wrangler.jsonc` 里的其余声明：Durable Object 绑定（`NodePushDO`，SQLite 类，迁移标签 `v2_node_push_do`）、每日 Cron（`0 3 * * *`，03:00 UTC）、Assets 绑定与 observability；并**自动创建 D1 数据库**（自动资源供给，见 3.7）。
- **不建议配置 build watch paths**：默认每次 push 都构建（本机构建很快）；若配置了监听路径而漏掉根目录 `bun.lock` / `package.json`，依赖变更提交将不触发部署。

### 3.4 管理员账号（/setup 向导，零 secrets）

**无需配置任何 secrets**。首次部署完成后打开面板地址，会自动引导进入 `/setup` 初始化页：设置管理员用户名（3-32 位字母/数字/下划线/连字符）与密码（≥8 位），提交即创建账号并直接进入面板。管理员账号存于数据库 `users` 表（`role='admin'`），密码以盐化哈希存储；向导仅在没有任何管理员时可用（重复访问提示直接登录）。

可选 secrets（一般不需要；本地 `bunx wrangler secret put <NAME>` 效果相同）：

| Secret | 作用 | 未设置时的行为 |
|---|---|---|
| `SESSION_SECRET` | 会话 cookie 的 HMAC 密钥 | 使用 /setup 向导生成的随机密钥（存于 `app_settings`，与管理员密码无关） |

### 3.5 绑定域名（推荐）

- 默认可用 `https://tyz.<你的子域>.workers.dev`。注意 workers.dev 在部分地区/线路可达性不稳，而**节点机必须稳定访问控制面**（WS 长连接 + 配置拉取），隧道类业务建议绑定自定义域名。
- 绑定方式：Worker → **Settings → Domains & Routes → Add → Custom domain**，域名需是本账号 Cloudflare Zone 内的 DNS 记录（自动签发边缘证书，无需自己管 TLS）。
- 绑定自定义域名后，可选在 `wrangler.jsonc` 加 `"workers_dev": false` 关闭 workers.dev 入口，收敛暴露面。

下文用 `https://tyz.example.com` 代指控制面地址。

### 3.6 触发并验证首次部署

```bash
git push origin master
```

在 Worker → **Deployments / Builds** 页面观察构建日志。首次部署时 wrangler 会自动创建 D1 数据库 `tyz` 并应用全部迁移（见 3.7）。

验证：

```bash
curl https://tyz.example.com/api/healthz        # → {"ok":true}
```

浏览器打开 `https://tyz.example.com/`，按 `/setup` 向导创建管理员账号（见 3.4）后直接进入管理面板。

### 3.7 D1 自动供给与迁移策略

**自动供给（无需关心 database_id）**：`wrangler.jsonc` 的 D1 绑定故意不写 `database_id`（依赖 wrangler ≥ 4.45 的自动资源供给）。首次 `wrangler deploy` 会在账户上创建 `database_name` 声明的数据库（默认 `tyz`，已存在同名则直接按名称关联），此后每次部署都按名称维持绑定——**仓库里永远不出现账户相关的 ID**，公共仓库与多人部署互不干扰。本地 `wrangler dev` 也会自动创建本地库。

**迁移全自动**：Deploy command 配置为 `bun run deploy:server`（即根 `package.json` 里的 `wrangler deploy && bun run db:migrate`；前端构建由 Build command 完成，脚本不重复构建）。顺序是**先部署后迁移**：首次部署时数据库由部署动作创建，迁移必须在它之后才能执行；日常发布保持迁移增量向后兼容（加表/加列），部署与迁移之间几秒的窗口不影响在线版本。**Workers Builds 默认创建的 token 即可完成建库与远端迁移**（2026-08 实测验证）；仅当关联的是接入前已存在的数据库且迁移报 403 时，才需要到 My Profile → API Tokens 给该 token 追加 D1:Edit。注意：本地手动执行 `bun run deploy:server` 前需先 `bun run build:web`（否则部署的是上次构建的旧产物），CF 流水线无此问题。

### 3.8 与仓库自带 GitHub Actions 的关系

- 控制面部署**不走 GitHub Actions**：仓库里的 Actions 只有 `check.yml`（lint + 类型检查 + agent clippy/测试 + 前端构建）、`docker-build.yml`（agent 镜像构建发布）和 `agent-release.yml`（agent 二进制发布），均与部署无关，fork 后可原样保留。

### 3.9 日常发布

此后控制面的全部发布就是：

```bash
git push origin master
```

发布前本地（或依赖 `check.yml`）确认：`bun run lint && bun run type-check && cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets && cargo test --manifest-path apps/agent/Cargo.toml`。

---

## 4. 管理面板初始化

按依赖顺序配置业务数据。所有写操作都会实时重算受影响节点的配置并经 WS 推送到在线 agent，**无需重启任何节点**。

### 4.1 节点（Nodes）

创建节点，关键字段：

| 字段 | 说明 |
|---|---|
| 名称 | 标识用 |
| address | 节点机**公网 IP 或可解析主机名，不含端口**（链路拨号地址 = address + 链路行端口；admission 白名单也取它的 host） |
| ports | 端口区间，如 `16800-16999`（自动分配用，见 2.2） |
| transport | 默认传输 |

创建成功后即可看到节点 Token——它就是该节点机 `.env` 里的 `NODE_TOKEN`。面板中令牌**常驻脱敏展示**（仅露尾 4 位，节点详情里可点「显示」查看完整值并复制）。泄露处置走「轮换 Token」（旧 token 立即失效，需同步更新节点机 `.env` 并重启容器）。

### 4.2 端点（Endpoints，可选）

预存命名转发目标（host + port）。规则引用端点时，端点地址变更会自动同步所有引用它的规则并重算配置；仍被引用的端点无法删除（409）。也可以不用端点，建规则时手填目标地址。

### 4.3 隧道与链路（Tunnels / Chains）

支持的形态与约束（写入时由 API 校验，聚合时再归一化兜底）：

| 形态 | chain 组成 | 说明 |
|---|---|---|
| 单节点直转 | 1 条 `in` 链 | 流量直接转发到目标地址 |
| 双节点中继 | 1 条 `in` + 1 条 `out` 链 | 默认 `relay` 模式：N 条入口规则共享出口的一个 relay 监听端口 |
| 双节点裸转 | 1 条 `in` + 1 条 `out` 链 | `forward_mode=raw`：每规则独立端口对，线路上无 relay 协议头（抗审查形态） |

- 链路行（chain）字段：节点、端口（`0` = 自动分配，见 2.2 公式）、传输（tcp/ws/grpc/tls/mwss…）、`index`（多跳排序）。
- **链路 TLS**（`tls_enabled`）仅支持双节点 relay 形态且出口传输为 `grpc` 或 `tls`：mTLS（平台签发证书）+ 每隧道 relay 凭据（自动生成）+ admission 白名单（自动收集入口节点 IP）三层认证；grpc 传输自动加 `/grpc` path 与 h2 ALPN 伪装。**前提：先在设置页配置 `tls_domain`（见 4.6），否则 TLS 隧道聚合直接报错。** 链路逐条添加即可：只缺一侧时视为搭建中的过渡态（聚合按明文 relay 处理），补齐第二侧后自动升级为 TLS；入口/出口超过一条、或出口传输不是 grpc/tls 会被立即拒绝并提示原因。
- `ingress_display_address` 是给用户看的展示地址，不参与任何配置生成。

### 4.4 规则（Rules）

| 字段 | 说明 |
|---|---|
| 隧道 | 必选；不挂隧道的规则不会出现在任何节点配置里 |
| 监听端口（listen_port） | 入口节点对外监听端口 |
| 出口端口（exit_port） | 仅 raw 模式；`0` = 自动分配（见 2.2 公式） |
| 目标 | 选择已存端点或手填 host:port |
| limit | 限速/限连 JSON（流量、请求速率、连接数，支持服务级与按 IP）——只在入口侧生效，避免双腿重复计数 |
| 所属用户 | 空 = 管理员规则（永不配额限制）；指定用户则受套餐配额硬停控制 |

### 4.5 套餐与用户（Packages / Users）

- 套餐：流量额度 / 周期天数 / 规则数上限 / 可用节点与隧道范围（空 = 不限）。
- 用户开通/切换/续订套餐 = 激活一条 `user_packages` 订阅记录。**切换或续订会重置用量窗口：历史已用流量在台账与 agent 计数器上同时清零（换购清零语义）**。
- 配额执行：服务端按计费台账（`traffic_hourly`，含线路倍率 `rate`）计算剩余量随配置下发；agent 端 GOST 配额对象执行硬停（配额只挡新连接，不断已有连接）。用户停用/无订阅/到期/耗尽时，其规则在聚合阶段被整体剔除（面板显示配额停用原因）。

### 4.6 链路 TLS 域名（tls_domain）

要让隧道启用链路 TLS（`tls_enabled`），必须先在**设置页 → TLS 域名**配置一个平台级 `tls_domain`，否则 TLS 隧道在聚合阶段直接报错。语义与运维要点：

- 它是**伪装用的 SNI/证书域名**（平台自签 CA 给链路签发证书，SAN/CN 用它；grpc 传输时也作为 `:authority` 伪装），**不需要真实 DNS 解析、不需要指向任何节点**——选一个你名下看起来正常的域名即可；
- 一个平台只有一个 `tls_domain`，修改它会自动作废并重签 server 证书，受影响节点重算配置并推送；
- 证书生命周期全自动：首次聚合懒生成，每日 Cron 在到期前 30 天自动续期（CA 不足 90 天时整套重发）；
- 设置页 / `GET /api/admin/tls/status` 只展示到期元数据，**私钥与证书材料仅经 agent 配置通道下发**，不出现在面板与审计中。

### 4.7 验证数据面

节点部署完成（第 5 节）后：

1. 面板 → 节点页：查看各节点服务健康（running / failed / apply_failed）与 WS 在线状态；
2. 从客户端向某规则的 `listen_port` 发流量（如 `curl http://<入口节点IP>:<listen_port>/`），应得到目标端点响应；
3. 稍候（统计默认 60s 批量上报）在面板节点统计 / 用户用量中看到流量回落。

---

## 5. 节点机部署（agent）

### 5.1 要求

- Linux x86_64 / arm64；
- 出站可达控制面域名 443；
- 节点间链路端口互通、客户端可达 `listen_port`；
- GOST 运行时已内嵌在 agent 二进制中，**无需安装任何其他东西**。

### 5.2 方式 A：Docker Compose（推荐）

在节点机上创建部署目录并写入 `.env`（完整变量表见附录 A；真实环境变量优先于 `.env`）：

```bash
mkdir -p /opt/tyz/data && cd /opt/tyz
cat > .env <<'EOF'
CONTROL_PLANE_URL=https://tyz.example.com
NODE_TOKEN=<面板创建该节点时显示的 token>
EOF
chmod 600 .env
```

写入 `docker-compose.yml`（镜像以 root 运行 + `./data` 宿主机绑定挂载，文件直接可见、无卷属主问题）：

```yaml
services:
  app:
    image: ghcr.io/laoshan-tech/tyz-node:latest   # 或固定版本 tag，见下
    container_name: tyz-app
    restart: unless-stopped
    network_mode: host                            # 必须：GOST 直接监听宿主端口
    volumes:
      - ./.env:/var/lib/tyz/.env:ro
      # 持久化：离线自举缓存 last-config.json、配额计数器 quota-store.json、
      # 链路 TLS 证书 certs/、自动生成的默认证书 $HOME/.gost
      - ./data:/var/lib/tyz
```

启动：

```bash
docker compose up -d
```

镜像来源二选一：

- **GHCR（CI 自动构建，amd64 + arm64）**：`ghcr.io/laoshan-tech/tyz-node`。生产建议固定版本 tag（发布页的 `vX.Y.Z`）而非 `latest`，升级节奏可控；
- **本地构建**：在仓库根执行 `docker build -f apps/agent/Dockerfile -t tyz-node:local .`（注意**构建上下文是仓库根**），导入节点机使用。

### 5.3 方式 B：裸机二进制 + systemd（备选）

构建与安装（在 release 页下载对应架构的 `tyz-agent-<tag>-linux-{amd64,arm64}.tar.gz` 并校验 SHA-256，或在任何装了 rustup 的机器上本地构建）：

```bash
cd apps/agent
TYZ_VERSION=dev cargo build --release --locked
# 产物：target/release/tyz-agent（x86_64；arm64 加 --target aarch64-unknown-linux-gnu
# 并设置 CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc）

scp target/release/tyz-agent root@<节点机>:/usr/local/bin/
```

节点机上：

```bash
# 专用系统用户与工作目录（持久化文件都落在这里）
useradd --system --home /var/lib/tyz --create-home --shell /usr/sbin/nologin tyz
install -m 600 /dev/null /etc/tyz-agent.env
cat > /etc/tyz-agent.env <<'EOF'
CONTROL_PLANE_URL=https://tyz.example.com
NODE_TOKEN=<该节点 token>
EOF
chown tyz /etc/tyz-agent.env
```

`/etc/systemd/system/tyz-agent.service`：

```ini
[Unit]
Description=TYZ node agent (embedded GOST)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tyz
Group=tyz
WorkingDirectory=/var/lib/tyz
EnvironmentFile=/etc/tyz-agent.env
ExecStart=/usr/local/bin/tyz-agent
Restart=always
RestartSec=5
# SIGTERM 触发优雅停机：先 flush 最终统计（内部上限 10s）
TimeoutStopSec=15
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now tyz-agent
```

### 5.4 持久化数据（务必保留）

工作目录（容器内 `/var/lib/tyz`）下的运行时状态，丢失后果各不相同：

| 文件/目录 | 作用 | 丢失后果 |
|---|---|---|
| `last-config.json` | 最近一次应用的配置（离线自举） | 控制面不可达时重启无法恢复隧道；恢复后也从零全量拉取 |
| `quota-store.json` | GOST 配额计数器（10s 落盘） | 配额计数归零，可能超发已用额度 |
| `certs/` | 平台签发的链路 TLS 证书/私钥 | 重启后由下次配置下发自动重写，无实际损失（链路会短暂重建） |
| `$HOME/.gost` | 自动生成的默认 TLS 证书 | 重新生成，自签场景对端需重新信任 |

### 5.5 验证

```bash
# 日志（agent 与内嵌 GOST 都打 stdout；节点在线看面板——有 stats 上报即在线）
docker logs -f tyz-app                 # 方式 A
journalctl -u tyz-agent -f             # 方式 B
```

正常启动日志：加载 env → 连接控制面 WS → 拉取配置 → 逐个 apply 服务。之后按 4.6 验证数据面与统计回流。

### 5.6 常用操作

```bash
docker compose pull && docker compose up -d   # 升级（方式 A）
docker logs --since 10m tyz-app               # 近 10 分钟日志
docker restart tyz-app                        # 重启（会重建全部 GOST 服务，断开存量连接）
```

> 面板上的「重启规则」按钮是更精细的操作：只重建该规则对应的 GOST 服务（raw 模式下入口/出口两端的同名服务都会重建；不服务该对象的节点自动忽略），不影响其他规则，且**不带任何配置变更**。日常排障优先用它。

---

## 6. 升级

### 6.1 控制面

`git push origin master`（含新迁移时先本地 `d1 migrations apply DB --remote`，见 3.7）。部署原子生效，无需停机。

### 6.2 agent

更新镜像 tag / 替换二进制后重启。重启语义：

- 启动时先重放 `last-config.json` 恢复全部隧道（控制面不可达也能恢复），再对齐版本（无变化则一次 304）；
- GOST 服务全部重建，**该节点存量连接会被断开**（通常会话层自动重连）；
- 配置热更新（不重启进程的常规变更）不受影响：chains/limiters/quotas 热切换不断连接，只有 service 本身变更才会断该规则的连接。

建议顺序：先升控制面、观察稳定后再逐台升 agent（agent 拉取的配置 payload 由控制面生成）。

---

## 7. 日常运维

### 7.1 日志

- agent 仅输出到 stdout（`docker logs` / `journalctl`）；健康快照只在 failed ↔ recovered 状态翻转时打日志，平时安静。
- 控制面：Worker → **Observability → Logs**（`observability.enabled` 已开）。

### 7.2 数据备份

D1 是唯一持久层，其中 **`traffic_hourly` 是计费台账且永不清理**——定期备份是硬要求：

```bash
bunx wrangler d1 export tyz --remote --output=backup-$(date +%F).sql   # 仓库根执行
```

建议至少每周一次（配额计算与用户用量全部依赖此表）。

### 7.3 定时巡检（每日 03:00 UTC Cron，自动）

- 清理：`gost_stats` > 30 天、`audit_log` > 180 天、`service_metrics_hourly` > 7 天（`traffic_hourly` 永不清理）；
- 配额扫描：订阅过期/额度耗尽/用户停用的规则被硬停（从聚合配置剔除），配置有实际变化的节点会收到推送；
- TLS 续期：30 天内到期的叶子证书自动重签，CA 低于 90 天时整套重发，受影响节点自动重算并推送。

### 7.4 高频手动操作

| 操作 | 位置 | 效果 |
|---|---|---|
| 重启规则 | 规则页 → 重启 | 只重建该规则的 GOST 服务（两端），断该规则连接，不改配置 |
| 重算配置 | 节点页 → 重算 | 强制重聚合该节点配置并推送（排障用） |
| 轮换节点 token | 节点页 → 轮换 | **旧 token 立即失效**；新 token 随弹窗展示并常驻详情页，需同步更新节点机 `.env` 并重启容器 |
| 用户换购/续订 | 用户页 → 订阅 | 用量窗口重置（清零） |

### 7.5 监控建议

- 对 `https://<域名>/api/healthz` 做拨测；节点在线状态看面板（有 stats 上报即在线，agent 无自有 HTTP 端口）；
- 面板节点页可看每服务健康与 24h 连接峰值，用户页可看配额停用原因；
- agent 掉线时控制面不会告警（推送只达在线 socket，重连后补拉），节点健康页是人工观察点。

---

## 8. 安全清单

- [ ] 可选 secret（`SESSION_SECRET`）只存 Worker secret，不进仓库/CI 变量；管理员账号经 /setup 向导存于数据库
- [ ] 管理员密码为强密码（单账户体系，无 2FA，必要时在前面加 Cloudflare Access）
- [ ] 节点 token 泄露立即走「轮换」（旧 token 立即失效）
- [ ] 节点机防火墙只放行：客户端接入端口、链路端口、出站 443（agent 无自有 HTTP 端口）
- [ ] `DEBUG=true` 仅测试/排障临时开启（随之启动的 GOST 调试 API 可读写运行时配置），用完即关；`GOST_API_ADDR` 保持 `127.0.0.1`
- [ ] 自定义域名绑定后考虑 `workers_dev: false` 收敛入口
- [ ] D1 定期 `export` 备份（计费数据）

敏感数据流向（已由代码保证，供审计对照）：

- 节点 token 明文存于数据库（面板是信任域，低敏凭据），面板脱敏展示、按需揭示，泄露处置 = 轮换；
- 链路 TLS 的 PEM 与 relay 凭据**只**经 agent 配置通道下发，从不出现在面板响应与审计日志中；
- `audit_log` 不记录任何 secret（token 轮换只记录动作不记录值）。

---

## 9. 故障排查

### Workers Builds（控制面）

| 症状 | 原因 | 处置 |
|---|---|---|
| 构建报 Worker 名不匹配 / 找不到 wrangler 配置 | Dashboard 的 Worker 名 ≠ `tyz`（配置在仓库根 `wrangler.jsonc`） | 名字改为 `tyz`（Settings → Build） |
| 部署命令里跑迁移报 403/权限错误 | Workers Builds 的 token 无 D1:Edit | 见 3.7：本地跑迁移，或给 token 补 D1:Edit |
| push 了但没触发构建 | 配置了 build watch paths 且路径不含改动文件 | 删掉 watch paths 配置（见 3.3） |
| 连接仓库时构建命令没有自动填 | 预期行为：自动预填是 Deploy 按钮流程专属，手动连接只做框架探测（探测不到） | 手动填一条 Build command：`bun run build:web`（见 3.2/3.3） |

### agent / 节点机

| 症状 | 原因 | 处置 |
|---|---|---|
| 容器启动即退出，日志有 `fatal:` | `CONTROL_PLANE_URL`/`NODE_TOKEN` 缺失，或某个 `*_MS` 变量非正整数 | 修正 `.env` 后 `docker compose up -d` |
| 日志 warn `mkdir .../.gost: permission denied` | 旧版镜像以非 root 用户运行，而挂载目录归 root | compose 的 app 服务加一行 `user: "0:0"` 后重建容器；或拉取以 root 运行的新镜像 |
| 面板显示节点不在线 | token 错误 / 出站 443 不通 / 控制面域名不可达 | 节点机 `curl https://tyz.example.com/api/healthz`；核对 token；确认域名解析 |
| 服务健康显示 `apply_failed` | 端口冲突（自动分配撞号或与宿主服务冲突） | 给该链路/规则显式指定端口；或调整节点 `ports` 区间消除重叠 |
| 改了配置但节点没生效 | WS 断连窗口内推送丢失 | agent 重连时立即补拉；5 分钟安全网轮询兜底。仍不行用节点页「重算」 |
| TLS 隧道创建后面板报聚合错误 | 未设置 `tls_domain` | 设置页配置平台 TLS 域名（见 4.6） |
| 对 TLS 端口发明文被立即断开 | 预期行为（TLS 监听拒绝非 TLS 流量） | 正常，无需处理 |
| 重启 agent 后隧道全断又立即恢复 | 正常：进程内 GOST 随重启重建 | — |

### 控制面 / 面板

| 症状 | 原因 | 处置 |
|---|---|---|
| 打开面板无法登录（接口 503 提示未初始化） | 数据库中尚无管理员账号（/setup 未完成） | 打开 `/setup` 页面完成管理员创建；已建过账号则直接用其登录 |
| 无法登录面板（401 invalid credentials） | 用户名或密码错误 | 核对 /setup 时设置的管理员账号；遗忘时删除 `users` 表中 `role='admin'` 的行可重新触发向导 |
| 能登录但面板数据报错（表不存在） | 部署命令未含迁移（Deploy command 不是 `bun run deploy:server`） | 按上文配置 Deploy command 重新部署；或本地执行 `bunx wrangler d1 migrations apply DB --remote` |
| 登录态频繁丢失 | 更改了 `SESSION_SECRET`（使所有会话失效，一次性） | 重新登录即可 |
| 统计/用量不更新 | agent 掉线或统计缓冲未到 flush 间隔 | 看节点在线状态；默认 60s 批量上报，稍等 |

---

## 附录

### A. agent 环境变量全表

| 变量 | 默认 | 说明 |
|---|---|---|
| `CONTROL_PLANE_URL` | **必填** | 控制面地址，如 `https://tyz.example.com`（末尾 `/` 自动去除） |
| `NODE_TOKEN` | **必填** | 节点 token（面板创建节点时显示） |
| `HOST` / `PORT` | 已移除 | agent 不再有自有健康端口；节点在线以持续 stats 上报为准 |
| `POLL_INTERVAL_MS` | `10000` | HTTP 轮询间隔（WS 健康时仅作 5 分钟安全网，不会按此频率打） |
| `STATS_FLUSH_INTERVAL_MS` | `60000` | 统计批量上报间隔（缓冲上限 1000，退出时 flush） |
| `WS_ENABLED` | `true` | `false` = 强制纯 HTTP 轮询 |
| `WS_PROBE_INTERVAL_MS` | `60000` | 降级轮询期间的 WS 重连探测间隔 |
| `WS_PING_INTERVAL_MS` | `60000` | WS 心跳（内部钳制 < 90s，适配边缘空闲超时） |
| `GOST_API_ADDR` | `127.0.0.1:18080` | GOST Web API 监听地址，**仅 `DEBUG=true` 时生效**（`/api` 前缀，读写调试面，`GET /api/config` 可看实际生效的 GOST 配置）；端口冲突时改这里 |
| `DEBUG` | 空 | `true` = 调试模式：详细日志 + 启动 GOST Web API（仅测试用） |

`.env` 从**工作目录**加载，真实环境变量优先。

### B. 命名约定（GOST 对象）

`service-{ruleId}`（入口/裸转出口）、`service-t{tunnelId}`（relay 共享出口）、`chain-{tunnelId}`、`node-{nodeId}-t{tunnelId}`、`hop-{tunnelId}-{index}`、`quota-user-{userId}`、`admission-t{tunnelId}`。跨版本 diff-apply 依赖这些确定性名字，不要在生成逻辑外改动。

### C. HTTP 端点清单

控制面：

- `GET /api/healthz` —— 存活探针
- `GET /api/agent/config?version=N`（304/200）、`GET /api/agent/ws`（Bearer token；推送 `config_changed` / `restart_service`，应答 ping→pong）、`POST /api/agent/stats`
- `POST /api/admin/login|logout`、`GET /api/admin/me`、CRUD `/api/admin/nodes|tunnels|chains|rules|users|packages|endpoints`，及 `nodes/:id/{recompute,rotate-token,stats,health,metrics}`、`users/:id/subscribe`、`rules/:id/restart`、`GET /api/admin/audit`、`GET /api/admin/tls/status`、`PUT /api/admin/settings/tls-domain`

agent：无自有 HTTP 端口（节点在线以持续上报为准）；`DEBUG=true` 时在 `GOST_API_ADDR`（默认 `127.0.0.1:18080`，`/api` 前缀）暴露内嵌 GOST Web API，可查看实际生效的 GOST 运行时配置。

### D. 参考链接

- Workers Builds 配置：<https://developers.cloudflare.com/workers/ci-cd/builds/configuration/>
- 构建镜像（预装工具）：<https://developers.cloudflare.com/workers/ci-cd/builds/build-image/>
- monorepo 接入：<https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/>
- Wrangler D1（迁移/导出）：<https://developers.cloudflare.com/d1/>
- 本地开发与测试：见仓库 `README.md`、`AGENTS.md`
