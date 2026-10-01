import { Card, Skeleton, Tabs } from "@heroui/react";
import { IconArrowsExchange, IconNetwork, IconPlus, IconServer, IconUsers } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, type LinkProps } from "@tanstack/react-router";
import type { DashboardSummary } from "@tyz/shared";
import { type ReactNode, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { api } from "../api";
import { formatTraffic } from "../format";
import { NodeHealthChip, nodeHealthKind } from "../health";
import { auditActionLabel } from "../labels";
import { dashboardSummaryOptions } from "../queries";
import { cn, DataText, PageHeader, PageShell, StatusChip } from "../ui";

const REFRESH_MS = 60_000;

// 图表色跟随主题语义 token。var() 只能放内联 style（SVG presentation attribute
// 对 var() 的支持跨浏览器不一致，属性里保留 hex 兜底；CSS 级联中内联 style 优先于
// 属性值）。recharts 会把 Area 的 style 同时透传到填充+描边两条 path，填充路径
// 误继承的描边由 index.css 的 .recharts-area-area 规则取消。
const UP_COLOR = "#10b981";
const UP_STROKE = "var(--success)";
const DOWN_COLOR = "#737373";
const DOWN_STROKE = "var(--accent)";
const SERIES_STROKES: Record<string, string> = { 上行: UP_STROKE, 下行: DOWN_STROKE };

// ---- Row 1: 状态统计卡（文字+数字在左，图标在右；异常以小字说明并点亮图标底色） ----

const CARD_TONES = {
  default: "bg-default text-default-foreground",
  danger: "bg-danger-soft text-danger-soft-foreground",
  warning: "bg-warning-soft text-warning-soft-foreground",
} as const;

function StatusCard({
  to,
  tone = "default",
  icon,
  label,
  value,
  hint,
}: {
  to: LinkProps["to"];
  tone?: keyof typeof CARD_TONES;
  icon: ReactNode;
  label: string;
  value?: number;
  hint?: string;
}) {
  return (
    <Link
      to={to}
      className="group block rounded-md outline-accent focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <Card className="transition-colors group-hover:border-accent">
        <Card.Content className="flex flex-row items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="text-sm text-muted">{label}</p>
            <p className="text-2xl font-semibold leading-tight tabular-nums">{value === undefined ? "--" : value}</p>
            {/* 始终渲染占位行保证四张卡片等高；异常信号由右侧图标底色承载，小字保持 muted 不抢戏 */}
            <p className="truncate text-xs text-muted">{hint ?? "\u00A0"}</p>
          </div>
          <div className={cn("flex size-11 shrink-0 items-center justify-center rounded-lg", CARD_TONES[tone])}>
            {icon}
          </div>
        </Card.Content>
      </Card>
    </Link>
  );
}

// ---- Row 2: 流量趋势 ----

type TrafficRange = "24h" | "7d";

interface TrafficTooltipProps {
  active?: boolean;
  label?: string;
  payload?: Array<{ name?: string; value?: number; color?: string }>;
}

function TrafficTooltip({ active, payload, label }: TrafficTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2 text-xs shadow-md">
      <p className="mb-1 text-muted">{label}</p>
      {payload.map((entry) => (
        <p key={entry.name} className="flex items-center gap-1.5">
          <span
            className="size-2 rounded-full"
            style={{ background: SERIES_STROKES[entry.name ?? ""] ?? entry.color }}
          />
          {entry.name}
          <DataText>{formatTraffic(entry.value ?? 0)}</DataText>
        </p>
      ))}
    </div>
  );
}

function TrafficChartCard() {
  const [range, setRange] = useState<TrafficRange>("24h");
  const hours = range === "24h" ? 24 : 168;
  const query = useQuery({
    queryKey: ["dashboard-traffic", hours],
    queryFn: () => api.dashboardTraffic(hours),
    refetchInterval: REFRESH_MS,
  });

  const data = useMemo(
    () =>
      (query.data?.rows ?? []).map((p) => ({
        ...p,
        label: range === "24h" ? p.hour_ts.slice(11, 16) : p.hour_ts.slice(5, 10),
      })),
    [query.data, range],
  );

  return (
    <Card className="h-full">
      <Card.Header className="pb-2">
        <Card.Title>计费流量趋势</Card.Title>
        <Card.Description>全平台按小时聚合（已含线路倍率），60 秒自动刷新</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs
            aria-label="时间范围"
            selectedKey={range}
            onSelectionChange={(key) => setRange(key as TrafficRange)}
            className="w-fit shrink-0"
          >
            <Tabs.List>
              <Tabs.Tab id="24h" className="whitespace-nowrap">
                24 小时
              </Tabs.Tab>
              <Tabs.Tab id="7d" className="whitespace-nowrap">
                近 7 天
              </Tabs.Tab>
            </Tabs.List>
          </Tabs>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: UP_STROKE }} />
              上行
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: DOWN_STROKE }} />
              下行
            </span>
          </div>
        </div>
        {query.isLoading ? (
          <Skeleton className="h-[280px] w-full rounded-md" />
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="dashUp" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={UP_COLOR} stopOpacity={0.25} style={{ stopColor: UP_STROKE }} />
                  <stop offset="100%" stopColor={UP_COLOR} stopOpacity={0.02} style={{ stopColor: UP_STROKE }} />
                </linearGradient>
                <linearGradient id="dashDown" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={DOWN_COLOR} stopOpacity={0.25} style={{ stopColor: DOWN_STROKE }} />
                  <stop offset="100%" stopColor={DOWN_COLOR} stopOpacity={0.02} style={{ stopColor: DOWN_STROKE }} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(128,128,128,0.2)"
                style={{ stroke: "var(--border)" }}
                vertical={false}
              />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, style: { fill: "var(--muted)" } }}
                tickLine={false}
                axisLine={false}
                minTickGap={28}
              />
              <YAxis
                tick={{ fontSize: 11, style: { fill: "var(--muted)" } }}
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={(v: number) => formatTraffic(v)}
              />
              <RTooltip content={<TrafficTooltip />} />
              <Area
                type="monotone"
                dataKey="billed_upload"
                name="上行"
                stroke={UP_COLOR}
                strokeWidth={1.8}
                fill="url(#dashUp)"
                style={{ stroke: UP_STROKE }}
              />
              <Area
                type="monotone"
                dataKey="billed_download"
                name="下行"
                stroke={DOWN_COLOR}
                strokeWidth={1.8}
                fill="url(#dashDown)"
                style={{ stroke: DOWN_STROKE }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </Card.Content>
    </Card>
  );
}

// ---- Row 2: 节点健康墙 ----

function NodeHealthWall({ nodes, loading }: { nodes: DashboardSummary["nodes_health"] | undefined; loading: boolean }) {
  return (
    <Card className="h-full">
      <Card.Header className="pb-2">
        <Card.Title>节点健康</Card.Title>
        <Card.Description>最新服务快照与 24h 连接峰值</Card.Description>
      </Card.Header>
      <Card.Content>
        {loading ? (
          <div className="flex flex-col gap-2">
            {[1, 2, 3, 4].map((n) => (
              <Skeleton key={n} className="h-11 w-full rounded-md" />
            ))}
          </div>
        ) : !nodes || nodes.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted">暂无节点</p>
        ) : (
          <div className="flex max-h-[326px] flex-col gap-1 overflow-y-auto">
            {nodes.map((n) => (
              <Link
                key={n.node_id}
                to="/nodes"
                search={{}}
                className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 outline-accent transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <IconServer
                    size={18}
                    stroke={2}
                    className={cn(
                      "shrink-0",
                      nodeHealthKind(n) === "ready"
                        ? "text-success"
                        : nodeHealthKind(n) === "abnormal"
                          ? "text-danger"
                          : "text-muted",
                    )}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm leading-tight font-medium">{n.name}</p>
                    <p className="text-xs text-muted">24h 峰值 {n.conn_peak_24h} 连接</p>
                  </div>
                </div>
                <NodeHealthChip health={n} />
              </Link>
            ))}
          </div>
        )}
      </Card.Content>
    </Card>
  );
}

// ---- Row 3: 今日流量 / 快捷操作 ----

function TodayTrafficCard({ traffic }: { traffic: DashboardSummary["traffic"] | undefined }) {
  const todayTotal = traffic ? traffic.today.upload + traffic.today.download : undefined;
  const yesterdayTotal = traffic ? traffic.yesterday.upload + traffic.yesterday.download : undefined;
  return (
    <Card className="h-full">
      <Card.Header className="pb-2">
        <Card.Title>今日计费流量</Card.Title>
        <Card.Description>UTC 日聚合，来自小时计费账本</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-2">
        <p className="text-3xl font-semibold tabular-nums">
          {todayTotal === undefined ? "--" : formatTraffic(todayTotal)}
        </p>
        {traffic && (
          <p className="text-sm text-muted">
            上行 <DataText>{formatTraffic(traffic.today.upload)}</DataText> · 下行{" "}
            <DataText>{formatTraffic(traffic.today.download)}</DataText>
          </p>
        )}
        <p className="text-xs text-muted">
          昨日全天 {yesterdayTotal === undefined ? "--" : formatTraffic(yesterdayTotal)}
        </p>
      </Card.Content>
    </Card>
  );
}

const QUICK_ACTIONS = [
  { to: "/nodes?create=1", label: "新建节点", icon: <IconServer size={16} stroke={2} /> },
  { to: "/tunnels?create=1", label: "新建隧道", icon: <IconNetwork size={16} stroke={2} /> },
  { to: "/rules?create=1", label: "新建规则", icon: <IconArrowsExchange size={16} stroke={2} /> },
  { to: "/users?create=1", label: "新建用户", icon: <IconUsers size={16} stroke={2} /> },
];

function QuickActionsCard() {
  return (
    <Card className="h-full">
      <Card.Header className="pb-2">
        <Card.Title>快捷操作</Card.Title>
        <Card.Description>直达各模块的新建入口</Card.Description>
      </Card.Header>
      <Card.Content className="grid grid-cols-2 gap-2">
        {QUICK_ACTIONS.map((action) => (
          <Link
            key={action.to}
            to={action.to}
            className="flex items-center gap-2 rounded-md border border-border px-3 py-2.5 text-sm outline-accent transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {action.icon}
            {action.label}
            <IconPlus size={13} stroke={2} className="ml-auto text-muted" />
          </Link>
        ))}
      </Card.Content>
    </Card>
  );
}

// ---- Row 4: 最近操作 ----

function RecentActivityCard() {
  const auditQuery = useQuery({
    queryKey: ["dashboard-audit"],
    queryFn: () => api.listAudit(8),
    refetchInterval: REFRESH_MS,
  });
  const rows = auditQuery.data?.rows ?? [];

  return (
    <Card>
      <Card.Header className="pb-2">
        <Card.Title>最近操作</Card.Title>
        <Card.Description>
          <Link to="/settings/audit" className="text-accent hover:underline">
            查看全部
          </Link>
        </Card.Description>
      </Card.Header>
      <Card.Content>
        {auditQuery.isLoading ? (
          <div className="flex flex-col gap-2">
            {[1, 2, 3].map((n) => (
              <Skeleton key={n} className="h-8 w-full rounded-md" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">暂无操作记录</p>
        ) : (
          <div className="flex flex-col">
            {rows.map((r) => {
              const info = auditActionLabel(r.action);
              return (
                <div key={r.id} className="flex items-center gap-3 border-b border-border py-2 last:border-b-0">
                  <DataText className="w-[7.5rem] shrink-0 text-muted">{r.ts.slice(5, 16).replace("T", " ")}</DataText>
                  <StatusChip tone={info.tone} title={r.action} className="shrink-0">
                    {info.label}
                  </StatusChip>
                  <span className="min-w-0 flex-1 truncate text-sm">{r.detail || "-"}</span>
                  {r.target_type && (
                    <DataText className="hidden shrink-0 text-muted sm:inline">
                      {r.target_type} #{r.target_id}
                    </DataText>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card.Content>
    </Card>
  );
}

// ---- Page ----

export default function DashboardPage() {
  const summaryQuery = useQuery({
    ...dashboardSummaryOptions,
    refetchInterval: REFRESH_MS,
  });
  const summary = summaryQuery.data;
  const nodeAbnormal = summary?.nodes_health.filter((n) => nodeHealthKind(n) === "abnormal").length ?? 0;
  const nodeOffline = summary?.nodes_health.filter((n) => nodeHealthKind(n) === "offline").length ?? 0;
  const nodeHint = [
    nodeAbnormal > 0 ? `${nodeAbnormal} 个服务异常` : null,
    nodeOffline > 0 ? `${nodeOffline} 个离线` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const rules = summary?.counts.rules;
  const ruleHint = [
    rules && rules.quota_stopped > 0 ? `配额停用 ${rules.quota_stopped}` : null,
    rules && rules.error > 0 ? `错误 ${rules.error}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const usersAgg = summary?.counts.users;
  const userHint = usersAgg && usersAgg.disabled > 0 ? `已禁用 ${usersAgg.disabled}` : "";

  return (
    <PageShell>
      <PageHeader title="控制台" description="平台运行总览" />

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatusCard
          to="/nodes"
          tone={nodeAbnormal > 0 ? "danger" : nodeOffline > 0 ? "warning" : "default"}
          icon={<IconServer size={22} stroke={2} />}
          label="节点"
          value={summary?.counts.nodes}
          hint={nodeHint || undefined}
        />
        <StatusCard
          to="/tunnels"
          icon={<IconNetwork size={22} stroke={2} />}
          label="隧道"
          value={summary?.counts.tunnels}
        />
        <StatusCard
          to="/rules"
          tone={(rules?.error ?? 0) > 0 ? "danger" : (rules?.quota_stopped ?? 0) > 0 ? "warning" : "default"}
          icon={<IconArrowsExchange size={22} stroke={2} />}
          label="规则"
          value={rules?.total}
          hint={ruleHint || undefined}
        />
        <StatusCard
          to="/users"
          icon={<IconUsers size={22} stroke={2} />}
          label="用户"
          value={usersAgg?.total}
          hint={userHint || undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <TrafficChartCard />
        </div>
        <NodeHealthWall nodes={summary?.nodes_health} loading={summaryQuery.isLoading} />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TodayTrafficCard traffic={summary?.traffic} />
        <QuickActionsCard />
      </div>

      <RecentActivityCard />
    </PageShell>
  );
}
