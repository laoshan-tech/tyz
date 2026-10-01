import type { DashboardSummary } from "@tyz/shared";
import { StatusChip } from "./ui";

export type NodeHealthSummary = DashboardSummary["nodes_health"][number];

/** 节点健康五态（唯一判定口径，控制台健康墙与节点列表共用）。 */
export type NodeHealthKind = "unreported" | "offline" | "abnormal" | "idle" | "ready";

/**
 * 判定顺序即语义优先级：`online` 由服务端按心跳时间派生（前端不自算时钟差）；
 * failed/apply_failed 只在 online 时算数——离线节点的历史失败行不再伪装成异常；
 * 空闲 = agent 活着但没部署任何服务（哨兵行新鲜、服务计数为 0）。
 */
export function nodeHealthKind(health: NodeHealthSummary | undefined): NodeHealthKind {
  if (health === undefined || health.last_report === null) return "unreported";
  if (!health.online) return "offline";
  if (health.failed > 0) return "abnormal";
  if (health.services === 0) return "idle";
  return "ready";
}

function reportTitle(health: NodeHealthSummary | undefined): string {
  return health?.last_report ? `最近上报 ${health.last_report.replace("T", " ").slice(0, 19)}` : "agent 未上报过心跳";
}

/** 列表行/健康墙共用的节点健康 chip。 */
export function NodeHealthChip({ health }: { health: NodeHealthSummary | undefined }) {
  const kind = nodeHealthKind(health);
  switch (kind) {
    case "abnormal":
      return (
        <StatusChip tone="danger" title={`${health?.failed ?? 0} 个服务失败/下发失败`}>
          {health?.failed ?? 0} 异常
        </StatusChip>
      );
    case "offline":
      return (
        <StatusChip tone="warning" title={`${reportTitle(health)}，超过阈值判离线`}>
          离线
        </StatusChip>
      );
    case "idle":
      return (
        <StatusChip tone="default" title="agent 在线，未部署服务">
          空闲
        </StatusChip>
      );
    case "unreported":
      return (
        <StatusChip tone="default" title="agent 未上报过心跳">
          未上报
        </StatusChip>
      );
    case "ready":
      return (
        <StatusChip tone="success" title={reportTitle(health)}>
          {health?.ready ?? 0}/{health?.services ?? 0} 就绪
        </StatusChip>
      );
  }
}
