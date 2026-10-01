import { agentHeartbeatSchema } from "@tyz/shared";
import { createDb } from "../db";
import type { Bindings } from "../env";
import { ingestHealthSnapshot } from "../services/health";

/**
 * Per-node Durable Object holding the agent WebSocket connections for one node.
 *
 * Uses the WebSocket Hibernation API: accepted sockets are managed by the
 * runtime (no persistent timers/memory while idle), and `state.getWebSockets()`
 * returns the live sockets even after the DO was evicted between messages.
 *
 * Protocol (server -> agent):
 *   {"type":"hello"}              on connect
 *   {"type":"config_changed"}     broadcast after an admin write recomputed this node
 *   {"type":"restart_service",
 *    "service":"service-5"}       broadcast by the manual rule-restart endpoint;
 *                                 the agent rebuilds that one service from its
 *                                 last applied config (dropping live connections)
 * Protocol (agent -> server):
 *   {"type":"heartbeat","health":[...]}
 *                                 the periodic liveness beat — the DO stamps the
 *                                 node's sentinel row and folds the snapshot into
 *                                 service_health, then answers "pong" (any inbound
 *                                 frame feeds the agent's read watchdog). Waking
 *                                 the DO once a minute per node is the accepted
 *                                 cost of carrying the heartbeat over the socket.
 *   "ping"  ->  "pong"            legacy keepalive, still answered by the runtime
 *                                 at the edge via setWebSocketAutoResponse so a
 *                                 not-yet-upgraded agent never flap-loops.
 */
export class NodePushDO implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Bindings,
  ) {
    // Legacy-agent tolerance: a pre-heartbeat agent keeps its link alive with
    // text "ping"; the edge answers without waking this object. Upgraded
    // agents never send it (they send heartbeat messages, handled below).
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/notify" && request.method === "POST") {
      // The body may carry a custom message object (e.g. a restart_service
      // directive); an empty body defaults to the config_changed broadcast.
      const message = await request.json().catch(() => null);
      const payload =
        message && typeof message === "object" && "type" in message
          ? JSON.stringify(message)
          : JSON.stringify({ type: "config_changed" });
      let notified = 0;
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.send(payload);
          notified++;
        } catch {
          // Socket died before eviction caught up; the agent's heartbeat will
          // drive its own reconnect.
        }
      }
      return Response.json({ notified });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: "hello" }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * Heartbeat over the push socket: pong FIRST (the agent's watchdog only
   * needs a frame — ingest latency or failure must never starve it), then
   * stamp liveness + fold the service snapshot. D1 failures are logged and
   * self-heal on the next beat; the socket stays up either way.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    try {
      ws.send("pong");
    } catch {
      // socket died mid-beat; the reconnect restamps liveness
    }
    if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "heartbeat") return;

    const beat = agentHeartbeatSchema.safeParse(parsed);
    if (!beat.success) {
      console.error("invalid heartbeat message", beat.error.flatten());
      return;
    }
    // The DO is addressed idFromName(String(nodeId)) — the name IS the node id.
    const nodeId = Number(this.state.id.name);
    const reportedAt = new Date().toISOString();
    await ingestHealthSnapshot(createDb(this.env.DB), nodeId, beat.data.health, reportedAt).catch((err) =>
      console.error("heartbeat ingest failed", err),
    );
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
}
