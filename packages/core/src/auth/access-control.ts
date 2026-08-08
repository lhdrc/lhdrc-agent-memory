import { createHash, randomBytes } from "node:crypto";
import { MemoryError, ErrorCodes } from "../errors.ts";
import type {
  AuthConfig,
  AuthContext,
  AuthRole,
  AuthToken,
  AuthUser,
  AuthedRequest,
  BrainGrant,
} from "./types.ts";
import { EMPTY_AUTH_CONFIG } from "./types.ts";

export function sha256Token(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function normalizeTokenHash(hash: string): string {
  return hash.replace(/^sha256:/i, "").toLowerCase();
}

export function parseAuthConfig(raw: unknown): AuthConfig {
  if (!raw || typeof raw !== "object") return { ...EMPTY_AUTH_CONFIG };
  const data = raw as Record<string, unknown>;
  const users: AuthUser[] = [];
  if (Array.isArray(data.users)) {
    for (const u of data.users) {
      if (!u || typeof u !== "object") continue;
      const row = u as Record<string, unknown>;
      const id = String(row.id ?? "").trim();
      if (!id) continue;
      const brains: Record<string, BrainGrant> = {};
      if (row.brains && typeof row.brains === "object") {
        for (const [bid, g] of Object.entries(row.brains as Record<string, unknown>)) {
          if (!g || typeof g !== "object") continue;
          const grant = g as Record<string, unknown>;
          const sources = Array.isArray(grant.sources)
            ? grant.sources.map(String)
            : ["*"];
          brains[bid] = {
            role: (String(grant.role ?? "reader") as AuthRole) || "reader",
            sources,
          };
        }
      }
      users.push({
        id,
        role: (String(row.role ?? "member") as AuthRole) || "member",
        brains,
      });
    }
  }
  const tokens: AuthToken[] = [];
  if (Array.isArray(data.tokens)) {
    for (const t of data.tokens) {
      if (!t || typeof t !== "object") continue;
      const row = t as Record<string, unknown>;
      const id = String(row.id ?? "").trim();
      const user = String(row.user ?? "").trim();
      const hash = String(row.hash ?? "").trim();
      if (!id || !user || !hash) continue;
      tokens.push({
        id,
        user,
        hash,
        brain: row.brain != null ? String(row.brain) : undefined,
      });
    }
  }
  return { users, tokens };
}

/** 签发明文 token，返回 { raw, hash, id }；调用方把 hash 写入 memory.yml。 */
export function issueToken(userId: string, brain?: string): { id: string; raw: string; hash: string } {
  const id = `tok_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  const raw = `dfm_${randomBytes(24).toString("base64url")}`;
  return { id, raw, hash: `sha256:${sha256Token(raw)}`, ...(brain ? { brain } : {}) };
}

function findUser(cfg: AuthConfig, userId: string): AuthUser | undefined {
  return cfg.users.find((u) => u.id === userId);
}

function resolveGrant(user: AuthUser, brainId: string): BrainGrant | null {
  const g = user.brains[brainId];
  if (g) return g;
  // 实例级 owner/admin：未显式列 brain 时默认全开
  if (user.role === "owner" || user.role === "admin") {
    return { role: user.role, sources: ["*"] };
  }
  return null;
}

function sourceAllowed(grant: BrainGrant, sourceId: string | null | undefined): boolean {
  if (!sourceId) return true;
  if (grant.sources.includes("*")) return true;
  return grant.sources.includes(sourceId);
}

function pathBrainId(path: string | null | undefined): string | null {
  if (!path) return null;
  const posix = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!posix.startsWith("brains/")) return null;
  const parts = posix.split("/");
  return parts[1] ?? null;
}

function pathSourceId(path: string | null | undefined): string | null {
  if (!path) return null;
  const posix = path.replace(/\\/g, "/");
  const parts = posix.split("/");
  const si = parts.indexOf("sources");
  if (si >= 0 && parts[si + 1]) return parts[si + 1]!;
  if (parts.includes("experiences")) return "_experience";
  if (parts.includes("skills")) return "_skill";
  return null;
}

/**
 * 鉴权入口（fail-closed for remote）。
 * - CLI + 无 token → trusted local owner
 * - remote + 无 token → E_AUTH
 * - token 无效 → E_AUTH
 * - brain/source/path 越权 → E_FORBIDDEN / E_PATH_ESCAPE
 */
export function authorize(req: AuthedRequest, authCfg: AuthConfig = EMPTY_AUTH_CONFIG): AuthContext {
  const tokenRaw = req.token?.trim() || null;

  // Trusted local CLI
  if (req.channel === "cli" && !tokenRaw) {
    return {
      userId: "local",
      role: "owner",
      brainId: req.brainId,
      allowedSources: ["*"],
      trustedLocal: true,
    };
  }

  if (!tokenRaw) {
    throw new MemoryError(ErrorCodes.AUTH, "未提供 token（非 trusted 通道）");
  }

  const digest = sha256Token(tokenRaw);
  const tok = authCfg.tokens.find((t) => normalizeTokenHash(t.hash) === digest);
  if (!tok) {
    throw new MemoryError(ErrorCodes.AUTH, "token 无效");
  }

  if (tok.brain && tok.brain !== req.brainId) {
    throw new MemoryError(ErrorCodes.FORBIDDEN, `token 未授权 brain: ${req.brainId}`);
  }

  const user = findUser(authCfg, tok.user);
  if (!user) {
    throw new MemoryError(ErrorCodes.AUTH, `token 用户不存在: ${tok.user}`);
  }

  const grant = resolveGrant(user, req.brainId);
  if (!grant) {
    throw new MemoryError(ErrorCodes.FORBIDDEN, `用户 ${user.id} 无权访问 brain ${req.brainId}`);
  }

  if (req.sourceId && !sourceAllowed(grant, req.sourceId)) {
    throw new MemoryError(ErrorCodes.FORBIDDEN, `source 未授权: ${req.sourceId}`);
  }

  const pathBrain = pathBrainId(req.path);
  if (pathBrain && pathBrain !== req.brainId) {
    throw new MemoryError(ErrorCodes.FORBIDDEN, `路径越权 brain: ${pathBrain}`);
  }
  // 含 .. 或绝对路径形态
  if (req.path) {
    const p = req.path.replace(/\\/g, "/");
    if (p.includes("..") || /^[a-zA-Z]:/.test(p) || p.startsWith("/")) {
      throw new MemoryError(ErrorCodes.PATH_ESCAPE, `路径非法: ${req.path}`);
    }
  }
  const pathSrc = pathSourceId(req.path);
  if (pathSrc && pathSrc !== "_experience" && pathSrc !== "_skill" && !sourceAllowed(grant, pathSrc)) {
    throw new MemoryError(ErrorCodes.FORBIDDEN, `路径 source 未授权: ${pathSrc}`);
  }

  return {
    userId: user.id,
    role: grant.role,
    brainId: req.brainId,
    allowedSources: grant.sources,
    trustedLocal: false,
    tokenId: tok.id,
  };
}

export function assertBrainScope(ctx: AuthContext, brainId: string): void {
  if (ctx.brainId !== brainId) {
    throw new MemoryError(ErrorCodes.FORBIDDEN, `brain 越权: ${brainId}`);
  }
}

export function assertSourceScope(ctx: AuthContext, sourceId: string): void {
  if (ctx.allowedSources.includes("*")) return;
  if (!ctx.allowedSources.includes(sourceId)) {
    throw new MemoryError(ErrorCodes.FORBIDDEN, `source 未授权: ${sourceId}`);
  }
}

export function assertPathScope(ctx: AuthContext, relPath: string): void {
  const posix = relPath.replace(/\\/g, "/");
  if (posix.includes("..")) {
    throw new MemoryError(ErrorCodes.PATH_ESCAPE, `路径含 ..: ${relPath}`);
  }
  if (posix.startsWith("brains/")) {
    const bid = posix.split("/")[1];
    if (bid !== ctx.brainId) {
      throw new MemoryError(ErrorCodes.FORBIDDEN, `路径指向其他 brain: ${bid}`);
    }
  }
  const src = pathSourceId(posix);
  if (src && src !== "_experience" && src !== "_skill") {
    assertSourceScope(ctx, src);
  }
}

/** 响应文本/JSON 泄漏检查（fuzz 用） */
export function responseContainsSecret(payload: unknown, secret: string): boolean {
  if (!secret) return false;
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return text.includes(secret);
}
