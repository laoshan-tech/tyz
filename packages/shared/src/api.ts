import type { RealmNodeConfig } from "./entities";

/** Response of GET /agent/config when a newer config version exists. */
export interface AgentConfigResponse {
  version: number;
  config: RealmNodeConfig;
}
