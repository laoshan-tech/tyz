/**
 * End-to-end push test against a running control plane (wrangler dev).
 *
 * Usage (inside apps/server):
 *   bun run scripts/test-ws-push.ts [baseUrl]
 *
 * Env: NODE_TOKEN (default "dev-token-1", the seed token), ADMIN_USER/ADMIN_PASS
 * (default admin/admin123 — created through /api/setup when the instance is
 * still uninitialized, mirroring the first-run wizard).
 *
 * Verifies: bad token rejected; hello on connect; heartbeat/pong round-trip
 * (the agent's keepalive frame carries the service snapshot); an admin write
 * broadcasts {"type":"config_changed"} to the node's socket.
 */
// Plain console output: this script runs standalone against a wrangler dev
// instance and has no workspace imports.
const logger = { info: console.log, error: console.error } as const;

const baseUrl = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");
const wsUrl = `${baseUrl.replace(/^http/, "ws")}/api/agent/ws`;
const nodeToken = process.env.NODE_TOKEN ?? "dev-token-1";
const adminUser = process.env.ADMIN_USER ?? "admin";
const adminPass = process.env.ADMIN_PASS ?? "admin123";

function fail(message: string): never {
  logger.error(`FAIL: ${message}`);
  process.exit(1);
}

function connect(token: string): { socket: WebSocket; messages: string[]; opened: Promise<boolean> } {
  const socket = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
  const messages: string[] = [];
  const opened = new Promise<boolean>((resolve) => {
    socket.onopen = () => resolve(true);
    socket.onclose = () => resolve(false);
  });
  socket.onmessage = (event: MessageEvent) => {
    if (typeof event.data === "string") messages.push(event.data);
  };
  return { socket, messages, opened };
}

async function main(): Promise<void> {
  // 1. Bad token must be rejected (upgrade fails, connection never opens).
  {
    const bad = connect("not-a-valid-token");
    const ok = await bad.opened;
    if (ok) fail("invalid token was accepted");
    logger.info("PASS: invalid token rejected");
  }

  // 2. Login and open the channel with the seed token. Fresh local databases
  //    have no admin yet — bootstrap one through the setup wizard endpoint.
  const statusResponse = await fetch(`${baseUrl}/api/setup/status`);
  if (!statusResponse.ok) fail(`setup status failed: ${statusResponse.status}`);
  const status = (await statusResponse.json()) as { initialized: boolean };
  if (!status.initialized) {
    const setupResponse = await fetch(`${baseUrl}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: adminUser, password: adminPass }),
    });
    if (!setupResponse.ok && setupResponse.status !== 409) {
      fail(`setup bootstrap failed: ${setupResponse.status}`);
    }
    logger.info(`PASS: admin bootstrapped via /api/setup (user ${adminUser})`);
  }
  const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: adminUser, password: adminPass }),
  });
  if (!loginResponse.ok) fail(`admin login failed: ${loginResponse.status}`);
  const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) fail("no session cookie from admin login");

  const good = connect(nodeToken);
  if (!(await good.opened)) fail("valid token connection failed");
  await waitFor(() => good.messages.some((m) => m.includes('"hello"')), 3000, "hello frame");
  logger.info("PASS: connected and received hello");

  // 3. Heartbeat round-trip: the beat must be answered with "pong" (the DO
  //    stamps liveness + folds the service snapshot before replying).
  good.socket.send(JSON.stringify({ type: "heartbeat", health: [] }));
  await waitFor(() => good.messages.includes("pong"), 3000, "pong reply");
  logger.info("PASS: heartbeat/pong round-trip");

  // 4. Admin write must broadcast config_changed to this socket.
  const update = await fetch(`${baseUrl}/api/admin/nodes/1`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ description: `ws-push-test ${new Date().toISOString()}` }),
  });
  if (!update.ok) fail(`admin node update failed: ${update.status}`);
  await waitFor(() => good.messages.some((m) => m.includes('"config_changed"')), 5000, "config_changed push");
  logger.info("PASS: admin write pushed config_changed");

  good.socket.close(1000);
  logger.info("All push checks passed");
  process.exit(0);
}

function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${what}`));
      }
    }, 50);
    timer.unref?.();
  });
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
