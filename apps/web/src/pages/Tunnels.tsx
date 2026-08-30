import { Button, FieldError, Switch, Table } from "@heroui/react";
import { IconEraser, IconPencil, IconPlus, IconRefresh, IconRoute, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import {
  type Chain,
  ChainType,
  type CreateChainInput,
  type CreateTunnelInput,
  type NodeWithMeta,
  Transport,
  type Tunnel,
  type TunnelWithMeta,
} from "@tyz/shared";
import { type FormEvent, useMemo, useState } from "react";
import { api } from "../api";
import { confirmDanger } from "../confirm";
import { chainTypeLabel } from "../labels";
import { nodesListOptions, tunnelsListOptions } from "../queries";
import {
  DataText,
  emptyState,
  type FormErrors,
  FormFooter,
  FormModal,
  FormShell,
  fail,
  hasErrors,
  IconAction,
  ListToolbar,
  NumberForm,
  PageHeader,
  PageShell,
  SearchInput,
  SelectForm,
  SideDrawer,
  StatusChip,
  TableError,
  TableLoading,
  TextForm,
  ToolbarButton,
  useCrudMutation,
  useFormValues,
} from "../ui";

// ---- Tunnel form ----

// forward_mode is retired — every tunnel renders with raw port-pair semantics
// on the realm agent (no relay protocol, one port pair per rule on both ends).

interface TunnelFormValues {
  name: string;
  ingress_display_address: string;
  description: string;
  tls_enabled: boolean;
}

function TunnelDialog({
  tunnel,
  opened,
  onClose,
}: {
  tunnel: TunnelWithMeta | null;
  opened: boolean;
  onClose: () => void;
}) {
  const { save, isPending } = useCrudMutation({
    invalidateKeys: [["tunnels"]],
    create: (input: CreateTunnelInput) => api.createTunnel(input),
    update: (id, input: CreateTunnelInput) => api.updateTunnel(id, input),
    onClose,
  });

  return (
    <FormModal title={tunnel === null ? "新建隧道" : `编辑隧道 #${tunnel.id}`} isOpen={opened} onClose={onClose}>
      {opened && (
        <TunnelForm
          key={tunnel?.id ?? "create"}
          tunnel={tunnel}
          submitting={isPending}
          onCancel={onClose}
          onSubmit={(input) => save(tunnel?.id ?? null, input)}
        />
      )}
    </FormModal>
  );
}

function TunnelForm({
  tunnel,
  onSubmit,
  submitting,
  onCancel,
}: {
  tunnel: TunnelWithMeta | null;
  onSubmit: (input: CreateTunnelInput) => void;
  submitting: boolean;
  onCancel: () => void;
}) {
  const { values, set } = useFormValues(() => ({
    name: tunnel?.name ?? "",
    ingress_display_address: tunnel?.ingress_display_address ?? "",
    description: tunnel?.description ?? "",
    tls_enabled: tunnel?.tls_enabled ?? false,
  }));
  const [errors, setErrors] = useState<FormErrors<TunnelFormValues>>({});

  const onSubmitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errs: FormErrors<TunnelFormValues> = {};
    if (!values.name.trim()) errs.name = "请输入名称";
    setErrors(errs);
    if (hasErrors(errs)) return;
    onSubmit({
      name: values.name,
      ingress_display_address: values.ingress_display_address || undefined,
      description: values.description || undefined,
      tls_enabled: values.tls_enabled,
    });
  };

  return (
    <FormShell onSubmit={onSubmitForm}>
      <TextForm label="名称" isRequired value={values.name} onChange={(v) => set("name", v)} error={errors.name} />
      <TextForm
        label="入口地址"
        placeholder="可选，如 entry.example.com:80"
        value={values.ingress_display_address}
        onChange={(v) => set("ingress_display_address", v)}
      />
      <div className="flex flex-col gap-1">
        <Switch
          isSelected={values.tls_enabled}
          onChange={(v) => set("tls_enabled", v)}
          isInvalid={!!errors.tls_enabled}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            TLS 加密链路（平台证书）
          </Switch.Content>
          {errors.tls_enabled ? <FieldError>{errors.tls_enabled}</FieldError> : null}
        </Switch>
        {values.tls_enabled ? (
          <p className="text-muted">
            入口与出口之间的链路以 TLS 1.3 加密（出口链路的传输需为 tls）。启用前请先在设置中配置 TLS 伪装域名。
          </p>
        ) : null}
      </div>
      <TextForm
        label="描述"
        multiline
        inputProps={{ rows: 2 }}
        value={values.description}
        onChange={(v) => set("description", v)}
      />
      <FormFooter onCancel={onCancel} isPending={submitting} />
    </FormShell>
  );
}

// ---- Chain form ----

const CHAIN_TYPE_OPTIONS = [
  { value: ChainType.IN, label: "入口 (in)" },
  { value: ChainType.OUT, label: "出口 (out)" },
];
// The realm data plane speaks kaminari TLS only; raw stays plaintext. Several
// out links form the tunnel's exit candidate set (load-balanced per rule).
const TRANSPORT_OPTIONS = [
  { value: Transport.RAW, label: "raw（明文 TCP）" },
  { value: Transport.TLS, label: "tls（TLS 1.3）" },
];
const STRATEGY_OPTIONS = [
  { value: "round", label: "round（轮询）" },
  { value: "iphash", label: "iphash（按客户端 IP 粘滞）" },
];

interface ChainFormValues {
  node_id: string | null;
  chain_type: string;
  transport: string;
  index: number;
  port: number;
  strategy: string;
}

function chainFormValues(chain: Chain | null): ChainFormValues {
  return chain
    ? {
        node_id: String(chain.node_id),
        chain_type: chain.chain_type,
        transport: chain.transport,
        index: chain.index,
        port: chain.port,
        strategy: chain.strategy,
      }
    : {
        node_id: null,
        chain_type: ChainType.IN,
        transport: Transport.RAW,
        index: 0,
        port: 0,
        strategy: "round",
      };
}

function ChainDialog({
  tunnelId,
  chain,
  nodes,
  opened,
  onClose,
}: {
  tunnelId: number;
  chain: Chain | null;
  nodes: NodeWithMeta[];
  opened: boolean;
  onClose: () => void;
}) {
  const { save, isPending } = useCrudMutation({
    invalidateKeys: [["chains", tunnelId], ["tunnels"]],
    create: (input: CreateChainInput) => api.createChain(input),
    update: (id, input: CreateChainInput) => api.updateChain(id, input),
    onClose,
  });

  return (
    <FormModal title={chain === null ? "添加链路" : `编辑链路 #${chain.id}`} isOpen={opened} onClose={onClose}>
      {opened && (
        <ChainForm
          key={chain?.id ?? "create"}
          chain={chain}
          nodes={nodes}
          submitting={isPending}
          onCancel={onClose}
          onSubmit={(input) => save(chain?.id ?? null, { ...input, tunnel_id: tunnelId })}
        />
      )}
    </FormModal>
  );
}

function ChainForm({
  chain,
  nodes,
  onSubmit,
  submitting,
  onCancel,
}: {
  chain: Chain | null;
  nodes: NodeWithMeta[];
  onSubmit: (input: Omit<CreateChainInput, "tunnel_id">) => void;
  submitting: boolean;
  onCancel: () => void;
}) {
  const { values, set } = useFormValues(() => chainFormValues(chain));
  const [errors, setErrors] = useState<FormErrors<ChainFormValues>>({});

  const onSubmitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errs: FormErrors<ChainFormValues> = {};
    if (!values.node_id) errs.node_id = "请选择节点";
    setErrors(errs);
    if (hasErrors(errs)) return;
    onSubmit({
      node_id: Number(values.node_id),
      chain_type: values.chain_type as ChainType.IN | ChainType.OUT,
      transport: values.transport as Transport.RAW | Transport.TLS,
      index: values.index,
      // 入口行的监听端口由转发规则指定，链路端口不适用（服务端同样强制 0）。
      port: values.chain_type === ChainType.IN ? 0 : values.port,
      strategy: values.strategy as "round" | "iphash",
    });
  };

  return (
    <FormShell onSubmit={onSubmitForm}>
      <SelectForm
        label="节点"
        placeholder="选择节点"
        options={nodes.map((n) => ({ value: String(n.id), label: `${n.name} (#${n.id})` }))}
        value={values.node_id}
        onChange={(v) => set("node_id", (v as string | null) ?? null)}
        error={errors.node_id}
      />
      <div className="grid grid-cols-2 gap-3">
        <SelectForm
          label="类型"
          options={CHAIN_TYPE_OPTIONS}
          value={values.chain_type}
          onChange={(v) => set("chain_type", String(v))}
        />
        <SelectForm
          label="传输"
          options={TRANSPORT_OPTIONS}
          value={values.transport}
          onChange={(v) => set("transport", String(v))}
        />
        <NumberForm label="顺序" minValue={0} value={values.index} onChange={(v) => set("index", v ?? 0)} />
        <NumberForm
          label="端口"
          minValue={0}
          maxValue={65535}
          hint={values.chain_type === ChainType.IN ? "入口行不适用：监听端口由转发规则指定" : "0 = 自动分配"}
          isDisabled={values.chain_type === ChainType.IN}
          value={values.port}
          onChange={(v) => set("port", v ?? 0)}
        />
      </div>
      <SelectForm
        label="策略（多出口分流）"
        options={STRATEGY_OPTIONS}
        value={values.strategy}
        onChange={(v) => set("strategy", String(v))}
        hint="隧道有多条出口链路时生效：按连接选择出口"
      />
      <FormFooter onCancel={onCancel} isPending={submitting} />
    </FormShell>
  );
}

// ---- Chains drawer ----

function ChainsDrawer({ tunnel, nodes, onClose }: { tunnel: Tunnel; nodes: NodeWithMeta[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Chain | null>(null);
  const [creating, setCreating] = useState(false);

  const chainsQuery = useQuery({ queryKey: ["chains", tunnel.id], queryFn: () => api.tunnelChains(tunnel.id) });
  // Chain changes also affect the tunnel list's derived mode display
  // (chain_count) — refresh both.
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["chains", tunnel.id] });
    queryClient.invalidateQueries({ queryKey: ["tunnels"] });
  };
  const deleteMutation = useMutation({ mutationFn: api.deleteChain, onSuccess: invalidate, onError: fail });

  const chains = chainsQuery.data?.chains ?? [];

  return (
    <SideDrawer title={`链路管理：${tunnel.name}`} isOpen onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-muted">按「顺序」从小到大排列组成完整转发链路</p>
        <div className="flex justify-end">
          <Button size="sm" onPress={() => setCreating(true)}>
            <IconPlus size={14} />
            添加链路
          </Button>
        </div>
        {chainsQuery.isLoading ? (
          <TableLoading />
        ) : (
          <Table.ScrollContainer>
            <Table className="min-w-[640px]">
              <Table.Content aria-label="链路列表">
                <Table.Header>
                  <Table.Column id="index" defaultWidth={60} isRowHeader>
                    顺序
                  </Table.Column>
                  <Table.Column id="node">节点</Table.Column>
                  <Table.Column id="type" defaultWidth={90}>
                    类型
                  </Table.Column>
                  <Table.Column id="transport" defaultWidth={80}>
                    传输
                  </Table.Column>
                  <Table.Column id="port" defaultWidth={80}>
                    端口
                  </Table.Column>
                  <Table.Column id="strategy" defaultWidth={90}>
                    策略
                  </Table.Column>
                  <Table.Column id="actions" defaultWidth={130}>
                    <span className="flex justify-end">操作</span>
                  </Table.Column>
                </Table.Header>
                <Table.Body
                  items={chains}
                  // 行渲染器闭包引用 nodes（另一个查询）；声明依赖避免 RAC 行缓存在节点名上停留在 "?"。
                  dependencies={[nodes]}
                  renderEmptyState={emptyState("暂无链路")}
                >
                  {(c) => (
                    <Table.Row id={c.id}>
                      <Table.Cell>
                        <DataText>{c.index}</DataText>
                      </Table.Cell>
                      <Table.Cell>
                        <span className="font-medium">
                          {nodes.find((n) => n.id === c.node_id)?.name ?? "?"}{" "}
                          <DataText className="text-muted">#{c.node_id}</DataText>
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <StatusChip tone={chainTypeLabel(c.chain_type).tone} title={c.chain_type}>
                          {chainTypeLabel(c.chain_type).label}
                        </StatusChip>
                      </Table.Cell>
                      <Table.Cell>
                        <DataText>{c.transport}</DataText>
                      </Table.Cell>
                      <Table.Cell>
                        <DataText>{c.port === 0 ? "自动" : c.port}</DataText>
                      </Table.Cell>
                      <Table.Cell>{c.strategy || "-"}</Table.Cell>
                      <Table.Cell>
                        <div className="flex justify-end gap-0.5">
                          <IconAction
                            label="编辑"
                            icon={<IconPencil size={16} stroke={2} />}
                            onPress={() => setEditing(c)}
                          />
                          <IconAction
                            label="删除"
                            tone="danger"
                            icon={<IconTrash size={16} stroke={2} />}
                            onPress={() =>
                              confirmDanger("删除链路", "确定删除该链路？", () => deleteMutation.mutate(c.id))
                            }
                          />
                        </div>
                      </Table.Cell>
                    </Table.Row>
                  )}
                </Table.Body>
              </Table.Content>
            </Table>
          </Table.ScrollContainer>
        )}
      </div>

      <ChainDialog
        tunnelId={tunnel.id}
        chain={null}
        nodes={nodes}
        opened={creating}
        onClose={() => setCreating(false)}
      />
      <ChainDialog
        tunnelId={tunnel.id}
        chain={editing}
        nodes={nodes}
        opened={editing !== null}
        onClose={() => setEditing(null)}
      />
    </SideDrawer>
  );
}

// ---- Page ----
// The forward-mode filter/chip is retired with forward_mode itself — every
// tunnel renders raw port pairs; the list shows chain count + TLS instead.

export default function TunnelsPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<TunnelWithMeta | null>(null);
  const { create: createParam } = useSearch({ strict: false }) as { create?: "1" };
  const [creating, setCreating] = useState(createParam === "1");
  const [chainsOf, setChainsOf] = useState<TunnelWithMeta | null>(null);
  const [search, setSearch] = useState("");

  const tunnelsQuery = useQuery(tunnelsListOptions);
  const nodesQuery = useQuery(nodesListOptions);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["tunnels"] });
  const deleteMutation = useMutation({ mutationFn: api.deleteTunnel, onSuccess: invalidate, onError: fail });

  const nodes = nodesQuery.data?.nodes ?? [];
  const tunnels = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = tunnelsQuery.data?.tunnels ?? [];
    if (!q) return all;
    return all.filter((t) =>
      [String(t.id), t.name, t.description ?? "", t.ingress_display_address ?? ""].some((field) =>
        field.toLowerCase().includes(q),
      ),
    );
  }, [tunnelsQuery.data, search]);

  return (
    <PageShell>
      <PageHeader title="隧道列表" description="隧道由一组有序链路组成，串联入口、中继与出口节点" />
      <ListToolbar
        action={
          <Button onPress={() => setCreating(true)}>
            <IconPlus size={16} />
            新建隧道
          </Button>
        }
      >
        <SearchInput value={search} onChange={setSearch} placeholder="搜索隧道" />
        <ToolbarButton
          icon={<IconEraser size={16} stroke={2} />}
          isDisabled={search === ""}
          onPress={() => {
            setSearch("");
          }}
        >
          重置
        </ToolbarButton>
        <ToolbarButton
          icon={<IconRefresh size={16} stroke={2} />}
          spinning={tunnelsQuery.isFetching}
          onPress={() => tunnelsQuery.refetch()}
        >
          刷新
        </ToolbarButton>
      </ListToolbar>
      {tunnelsQuery.isError ? (
        <TableError onRetry={() => tunnelsQuery.refetch()} />
      ) : tunnelsQuery.isLoading ? (
        <TableLoading />
      ) : (
        <Table.ScrollContainer>
          <Table className="min-w-[720px]">
            <Table.Content aria-label="隧道列表">
              <Table.Header>
                <Table.Column id="id" defaultWidth={60} isRowHeader>
                  ID
                </Table.Column>
                <Table.Column id="name">名称</Table.Column>
                <Table.Column id="mode" defaultWidth={150}>
                  模式
                </Table.Column>
                <Table.Column id="ingress">入口地址</Table.Column>
                <Table.Column id="description">描述</Table.Column>
                <Table.Column id="actions" defaultWidth={190}>
                  <span className="flex justify-end">操作</span>
                </Table.Column>
              </Table.Header>
              <Table.Body
                items={tunnels}
                renderEmptyState={emptyState(search ? "没有匹配的结果" : "暂无数据，点击「新建隧道」开始")}
              >
                {(t) => (
                  <Table.Row id={t.id}>
                    <Table.Cell>
                      <DataText>{t.id}</DataText>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="font-medium">{t.name}</span>
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex items-center gap-1">
                        <StatusChip tone="default" title={`链路数（入口 + 出口）`}>
                          {t.chain_count} 链路
                        </StatusChip>
                        {t.tls_enabled ? (
                          <StatusChip tone="success" title="链路 TLS（平台证书）">
                            TLS
                          </StatusChip>
                        ) : null}
                      </div>
                    </Table.Cell>
                    <Table.Cell>{t.ingress_display_address ?? <span className="text-muted">-</span>}</Table.Cell>
                    <Table.Cell>
                      {t.description ? <span>{t.description}</span> : <span className="text-muted">-</span>}
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex justify-end gap-0.5">
                        <IconAction
                          label="编辑"
                          icon={<IconPencil size={16} stroke={2} />}
                          onPress={() => setEditing(t)}
                        />
                        <IconAction
                          label="链路管理"
                          icon={<IconRoute size={16} stroke={2} />}
                          onPress={() => setChainsOf(t)}
                        />
                        <IconAction
                          label="删除"
                          tone="danger"
                          icon={<IconTrash size={16} stroke={2} />}
                          onPress={() =>
                            confirmDanger("删除隧道", "其下链路与规则关联将一并清理，确定？", () =>
                              deleteMutation.mutate(t.id),
                            )
                          }
                        />
                      </div>
                    </Table.Cell>
                  </Table.Row>
                )}
              </Table.Body>
            </Table.Content>
          </Table>
        </Table.ScrollContainer>
      )}

      <TunnelDialog tunnel={null} opened={creating} onClose={() => setCreating(false)} />
      <TunnelDialog tunnel={editing} opened={editing !== null} onClose={() => setEditing(null)} />
      {chainsOf !== null && (
        <ChainsDrawer key={chainsOf.id} tunnel={chainsOf} nodes={nodes} onClose={() => setChainsOf(null)} />
      )}
    </PageShell>
  );
}
