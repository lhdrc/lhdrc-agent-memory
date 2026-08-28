import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { loadRepoConfig } from "./config.ts";

export const CONFIG_SET_WHITELIST = [
  "embedding.provider",
  "embedding.model",
  "embedding.dims",
  "embedding.base_url",
  "embedding.openai_api_key_env",
  "embedding.onnx_model_path",
  "llm.provider",
  "llm.model",
  "llm.base_url",
  "llm.openai_api_key_env",
  "llm.extract",
  "llm.distill",
  "llm.kill_switch.compile",
  "llm.kill_switch.extract",
  "llm.kill_switch.distill",
  "llm.kill_switch.abstract",
  "distill.lazy_min_sources",
  "distill.auto_crystallize",
  "layers.auto",
  "write.dedupe_cosine",
  "compile.job_timeout_ms",
  "cost.daily_token_cap",
  "index.engine",
] as const;

export type ConfigSetKey = (typeof CONFIG_SET_WHITELIST)[number];

const SECRET_KEY_RE = /(^|\.)(openai_api_key|api_key|secret|token)$/i;
const SECRET_VALUE_RE = /^(sk-|rk-)[A-Za-z0-9_\-]{8,}$/;

export interface SetRepoConfigResult {
  key: string;
  value: string;
  warnings: string[];
}

function looksLikeSecretKey(key: string): boolean {
  if (key.endsWith("_env") || key.endsWith(".openai_api_key_env")) return false;
  return SECRET_KEY_RE.test(key) || /api[_-]?key/i.test(key.replace(/openai_api_key_env/g, ""));
}

function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUE_RE.test(value.trim());
}

function setDotted(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    const next = cur[p];
    if (next == null || typeof next !== "object" || Array.isArray(next)) {
      cur[p] = {};
    }
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

function coerceValue(key: string, raw: string): unknown {
  const v = raw.trim();
  if (key === "llm.provider") {
    if (v !== "off" && v !== "openai") {
      throw new MemoryError(ErrorCodes.USAGE, `llm.provider 必须是 off|openai，收到: ${v}`);
    }
    return v;
  }
  if (key === "embedding.provider") {
    if (v !== "off" && v !== "local" && v !== "openai" && v !== "onnx") {
      throw new MemoryError(ErrorCodes.USAGE, `embedding.provider 必须是 off|local|openai|onnx，收到: ${v}`);
    }
    return v;
  }
  if (key === "index.engine") {
    if (v !== "pglite" && v !== "postgres") {
      throw new MemoryError(ErrorCodes.USAGE, `index.engine 必须是 pglite|postgres，收到: ${v}`);
    }
    return v;
  }
  if (
    key.endsWith(".extract") ||
    key.endsWith(".distill") ||
    key.endsWith(".auto") ||
    key.endsWith(".auto_crystallize") ||
    key.includes("kill_switch.")
  ) {
    if (v === "true") return true;
    if (v === "false") return false;
    throw new MemoryError(ErrorCodes.USAGE, `${key} 必须是 true|false`);
  }
  if (
    key.endsWith(".dims") ||
    key.endsWith("_ms") ||
    key.endsWith("_cap") ||
    key.endsWith("_sources") ||
    key.endsWith("dedupe_cosine")
  ) {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new MemoryError(ErrorCodes.USAGE, `${key} 必须是数字`);
    return n;
  }
  return v;
}

export function parseSetAssignment(raw: string): { key: string; value: string } {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    throw new MemoryError(ErrorCodes.USAGE, "config set 需要 dotted.key=value");
  }
  return { key: raw.slice(0, eq).trim(), value: raw.slice(eq + 1) };
}

export async function setRepoConfigKey(
  repoRoot: string,
  key: string,
  rawValue: string,
): Promise<SetRepoConfigResult> {
  if (looksLikeSecretKey(key) || looksLikeSecretValue(rawValue)) {
    throw new MemoryError(
      ErrorCodes.USAGE,
      "禁止把 API key / token 写入 memory.yml；只允许改 openai_api_key_env（环境变量名）",
    );
  }
  if (!(CONFIG_SET_WHITELIST as readonly string[]).includes(key)) {
    throw new MemoryError(
      ErrorCodes.USAGE,
      `未知或不可 set 的键: ${key}。白名单: ${CONFIG_SET_WHITELIST.join(", ")}`,
    );
  }
  const coerced = coerceValue(key, rawValue);
  const path = join(repoRoot, "memory.yml");
  const raw = await readFile(path, "utf8");
  const data = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  setDotted(data, key, coerced);
  await writeFile(path, stringifyYaml(data), "utf8");

  const cfg = await loadRepoConfig(repoRoot);
  const warnings: string[] = [];
  if (key === "llm.provider" && cfg.llm.provider === "openai") {
    const env = cfg.llm.openai_api_key_env || "OPENAI_API_KEY";
    if (!process.env[env]?.trim()) {
      warnings.push(`missing ${env}；remember 仍会 E_DISABLED，直到 export 该变量`);
    }
  }
  if (key === "embedding.provider" && cfg.embedding.provider === "openai") {
    const env = cfg.embedding.openai_api_key_env || "OPENAI_API_KEY";
    if (!process.env[env]?.trim()) {
      warnings.push(`missing ${env}；query 将哈希降级；remember 仍要 llm.provider=openai`);
    }
  }
  if (key.startsWith("embedding.") && (key.endsWith(".provider") || key.endsWith(".dims") || key.endsWith(".model"))) {
    warnings.push("换 embedding provider/dims/model 后请 memory rebuild-index --embeddings（或 --pending-embeddings）");
  }
  return { key, value: String(coerced), warnings };
}
