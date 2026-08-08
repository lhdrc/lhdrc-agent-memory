/**
 * P3.3 AccessControl：CLI trusted local + token 鉴权内核（供 P4.1 复用）。
 * 权威：specs/三期/P3.3-multitenant.md §3
 */

export type AuthRole = "owner" | "admin" | "member" | "reader";
export type AuthChannel = "cli" | "remote";

export interface BrainGrant {
  role: AuthRole;
  sources: string[]; // ["*"] = 全部
}

export interface AuthUser {
  id: string;
  role: AuthRole;
  brains: Record<string, BrainGrant>;
}

export interface AuthToken {
  id: string;
  user: string;
  /** sha256 hex（可带 sha256: 前缀） */
  hash: string;
  /** 可选收窄到单一 brain */
  brain?: string;
}

export interface AuthConfig {
  users: AuthUser[];
  tokens: AuthToken[];
}

export interface AuthedRequest {
  /** 原始 token（明文）；仅校验 hash，不落盘 */
  token?: string | null;
  brainId: string;
  /** 操作路径（仓内相对或 brain 相对） */
  path?: string | null;
  sourceId?: string | null;
  op?: string;
  /** cli = trusted local；remote = 未来 MCP/REST（无 token → E_AUTH） */
  channel: AuthChannel;
}

export interface AuthContext {
  userId: string;
  role: AuthRole;
  brainId: string;
  allowedSources: string[];
  trustedLocal: boolean;
  tokenId?: string;
}

export const EMPTY_AUTH_CONFIG: AuthConfig = { users: [], tokens: [] };
