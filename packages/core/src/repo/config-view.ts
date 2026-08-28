import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { readFile } from "node:fs/promises";
import { ErrorCodes } from "../errors.ts";
import { hasOpenAiEmbedKey } from "../embed/factory.ts";
import { onnxWeightsPresent } from "../embed/onnx.ts";
import { isEnvMockCompleteEnabled } from "../llm/mock.ts";
import { readEmbeddingMeta } from "../index/meta.ts";
import { loadRepoConfig, type RepoConfig } from "./config.ts";

export type ConfigReady = "ok" | "missing_key" | "off" | "warn";

export interface ConfigRow {
  key: string;
  value: string;
  source: "file" | "default";
  effect: string;
  needs: string;
  ready: ConfigReady;
}

export interface DoctorIssue {
  code: string;
  message: string;
  key?: string;
}

export interface DoctorReport {
  ok: boolean;
  rows: ConfigRow[];
  issues: DoctorIssue[];
  hints: string[];
}

const EFFECTS: Record<string, string> = {
  "llm.provider": "remember/compile 须 llm.provider=openai（或 --no-extract）",
  "llm.model": "complete() 所用 chat 模型",
  "llm.base_url": "chat/completions 网关",
  "llm.openai_api_key_env": "LLM 密钥所在环境变量名（不把 token 写入 yml）",
  "llm.extract": "capture/import enrich 是否走 complete(extract)",
  "llm.distill": "蒸馏/refine；还须 provider≠off 且 kill_switch.distill=false",
  "llm.kill_switch.compile": "true 时挡住 remember/compile",
  "llm.kill_switch.extract": "true 时挡住 enrich 抽 facts",
  "llm.kill_switch.distill": "true 时挡住蒸馏",
  "llm.kill_switch.abstract": "true 时挡住 layers abstract",
  "embedding.provider": "query/think 语义臂；openai 缺 key 则哈希降级",
  "embedding.model": "embeddings 模型名",
  "embedding.dims": "向量维；改后须 rebuild-index --embeddings",
  "embedding.base_url": "embeddings 兼容网关",
  "embedding.openai_api_key_env": "embedding 密钥环境变量名",
  "embedding.onnx_model_path": "onnx 权重路径",
  "compile.job_timeout_ms": "异步 remember/compile 超时",
  "compile.dedupe_cosine": "会话 compile 余弦去重阈值",
  "write.dedupe_cosine": "capture/import enrich 余弦去重（与 compile 不是同一键）",
  "distill.lazy_min_sources": "≤0 关懒蒸馏；compile 后是否自动 refine",
  "distill.auto_crystallize": "refine 后是否自动结晶 candidate",
  "layers.auto": "capture 后是否 maybeAutoAbstract",
  "cost.daily_token_cap": ">0 时 complete 可 skipped",
  "index.engine": "pglite 或 postgres（postgres 须 DF_MEMORY_DATABASE_URL）",
  "search.tokenmax.rerank": "现网 model 未接线，实际掉 local 启发式",
  "search.scope_first": "CLI query 默认关；think 强制开",
};

function dottedGet(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function fileHas(fileData: Record<string, unknown>, path: string): boolean {
  return dottedGet(fileData, path) !== undefined;
}

function fmt(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return String(v);
}

function envReady(envName: string, needed: boolean): ConfigReady {
  if (!needed) return "ok";
  return process.env[envName]?.trim() ? "ok" : "missing_key";
}

export async function buildConfigRows(repoRoot: string): Promise<ConfigRow[]> {
  const cfg = await loadRepoConfig(repoRoot);
  let fileData: Record<string, unknown> = {};
  try {
    const raw = await readFile(join(repoRoot, "memory.yml"), "utf8");
    fileData = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  } catch {
    fileData = {};
  }
  const embedEnv = cfg.embedding.openai_api_key_env || "OPENAI_API_KEY";
  const llmEnv = cfg.llm.openai_api_key_env || "OPENAI_API_KEY";
  const embedNeedsKey = cfg.embedding.provider === "openai";
  const llmNeedsKey = cfg.llm.provider === "openai" && !isEnvMockCompleteEnabled();

  const items: Array<{ key: string; value: unknown; needs?: string; ready?: ConfigReady }> = [
    {
      key: "llm.provider",
      value: cfg.llm.provider,
      needs: llmNeedsKey ? `env:${llmEnv}` : "—",
      ready: cfg.llm.provider === "off" ? "off" : envReady(llmEnv, llmNeedsKey),
    },
    { key: "llm.model", value: cfg.llm.model },
    { key: "llm.base_url", value: cfg.llm.base_url },
    { key: "llm.openai_api_key_env", value: cfg.llm.openai_api_key_env, needs: `env:${llmEnv}` },
    { key: "llm.extract", value: cfg.llm.extract },
    { key: "llm.distill", value: cfg.llm.distill },
    { key: "llm.kill_switch.compile", value: cfg.llm.kill_switch.compile },
    { key: "llm.kill_switch.extract", value: cfg.llm.kill_switch.extract },
    { key: "llm.kill_switch.distill", value: cfg.llm.kill_switch.distill },
    { key: "llm.kill_switch.abstract", value: cfg.llm.kill_switch.abstract },
    {
      key: "embedding.provider",
      value: cfg.embedding.provider,
      needs: embedNeedsKey ? `env:${embedEnv}` : cfg.embedding.provider === "onnx" ? "onnx_model_path" : "—",
      ready:
        cfg.embedding.provider === "off"
          ? "off"
          : cfg.embedding.provider === "openai"
            ? hasOpenAiEmbedKey(cfg.embedding)
              ? "ok"
              : "missing_key"
            : cfg.embedding.provider === "onnx"
              ? onnxWeightsPresent(cfg.embedding)
                ? "ok"
                : "missing_key"
              : "ok",
    },
    { key: "embedding.model", value: cfg.embedding.model },
    { key: "embedding.dims", value: cfg.embedding.dims },
    { key: "embedding.base_url", value: cfg.embedding.base_url },
    { key: "embedding.openai_api_key_env", value: cfg.embedding.openai_api_key_env, needs: `env:${embedEnv}` },
    { key: "embedding.onnx_model_path", value: cfg.embedding.onnx_model_path },
    { key: "compile.job_timeout_ms", value: cfg.compile.job_timeout_ms },
    { key: "compile.dedupe_cosine", value: cfg.compile.dedupe_cosine },
    { key: "write.dedupe_cosine", value: cfg.write.dedupe_cosine },
    { key: "distill.lazy_min_sources", value: cfg.distill.lazy_min_sources },
    { key: "distill.auto_crystallize", value: cfg.distill.auto_crystallize },
    { key: "layers.auto", value: cfg.layers.auto },
    { key: "cost.daily_token_cap", value: cfg.cost.daily_token_cap },
    {
      key: "index.engine",
      value: cfg.index.engine,
      needs: cfg.index.engine === "postgres" ? "env:DF_MEMORY_DATABASE_URL" : "—",
      ready:
        cfg.index.engine === "postgres"
          ? process.env.DF_MEMORY_DATABASE_URL?.trim()
            ? "ok"
            : "missing_key"
          : "ok",
    },
    {
      key: "search.tokenmax.rerank",
      value: cfg.search.tokenmax.rerank,
      ready: cfg.search.tokenmax.rerank === "model" ? "warn" : "ok",
    },
    { key: "search.scope_first", value: cfg.search.scope_first === true },
  ];

  return items.map((it) => ({
    key: it.key,
    value: fmt(it.value),
    source: fileHas(fileData, it.key) ? "file" : "default",
    effect: EFFECTS[it.key] ?? "—",
    needs: it.needs ?? "—",
    ready: it.ready ?? "ok",
  }));
}

export async function buildDoctorReport(repoRoot: string): Promise<DoctorReport> {
  const cfg = await loadRepoConfig(repoRoot);
  const rows = await buildConfigRows(repoRoot);
  const issues: DoctorIssue[] = [];
  const hints: string[] = [];

  const embedRow = rows.find((r) => r.key === "embedding.provider");
  if (embedRow?.ready === "missing_key") {
    issues.push({
      code: ErrorCodes.DISABLED,
      key: "embedding.provider",
      message:
        cfg.embedding.provider === "onnx"
          ? "onnx 权重缺失；query 语义臂将哈希降级"
          : `未检测到 ${cfg.embedding.openai_api_key_env || "OPENAI_API_KEY"}；query 语义臂将 fail-open 为本地哈希`,
    });
  }
  const llmRow = rows.find((r) => r.key === "llm.provider");
  if (llmRow?.ready === "missing_key") {
    issues.push({
      code: ErrorCodes.DISABLED,
      key: "llm.provider",
      message: `未检测到 ${cfg.llm.openai_api_key_env || "OPENAI_API_KEY"}；remember 会 E_DISABLED`,
    });
  }
  if (cfg.llm.provider === "off") {
    hints.push("remember/compile 须 llm.provider=openai 或使用 remember --no-extract");
  }
  if (cfg.index.engine === "postgres" && !process.env.DF_MEMORY_DATABASE_URL?.trim()) {
    issues.push({
      code: ErrorCodes.DISABLED,
      key: "index.engine",
      message: "index.engine=postgres 需要环境变量 DF_MEMORY_DATABASE_URL",
    });
  }
  if (cfg.search.tokenmax.rerank === "model") {
    hints.push("search.tokenmax.rerank=model 现网未接线，实际掉 local 启发式");
  }
  const meta = await readEmbeddingMeta(repoRoot);
  if (meta && (meta.provider !== cfg.embedding.provider || (cfg.embedding.dims != null && meta.dims !== cfg.embedding.dims))) {
    hints.push("embedding-meta 与当前 provider/dims 不一致；请 memory rebuild-index --embeddings");
  }
  if (cfg.embedding.provider === "openai" && !hasOpenAiEmbedKey(cfg.embedding) && cfg.llm.provider === "off") {
    hints.push("会话写入请: memory config set llm.provider=openai（并 export 同一 key）");
  }
  if (!existsSync(join(repoRoot, "memory.yml"))) {
    issues.push({ code: ErrorCodes.NOT_FOUND, message: "memory.yml 不存在" });
  }

  return {
    ok: issues.length === 0,
    rows,
    issues,
    hints,
  };
}

export function formatConfigRows(rows: ConfigRow[]): string {
  const lines = ["key\tvalue\tsource\tready\tneeds\teffect"];
  for (const r of rows) {
    lines.push(`${r.key}\t${r.value}\t${r.source}\t${r.ready}\t${r.needs}\t${r.effect}`);
  }
  return lines.join("\n");
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [formatConfigRows(report.rows), ""];
  if (report.issues.length) {
    lines.push("issues:");
    for (const i of report.issues) lines.push(`  [${i.code}] ${i.key ?? ""} ${i.message}`.trimEnd());
  }
  if (report.hints.length) {
    lines.push("hints:");
    for (const h of report.hints) lines.push(`  ${h}`);
  }
  lines.push(report.ok ? "doctor: ok" : "doctor: not ready");
  return lines.join("\n");
}

export function initMissingKeyHint(cfg: RepoConfig): string | null {
  if (cfg.embedding.provider !== "openai") return null;
  if (hasOpenAiEmbedKey(cfg.embedding)) return null;
  const env = cfg.embedding.openai_api_key_env || "OPENAI_API_KEY";
  return [
    `embedding.provider=openai 但未检测到 ${env}`,
    "  query 语义臂将 fail-open 为本地哈希",
    "  会话写入请: memory config set llm.provider=openai  （并 export 同一 key）",
    "  查看: memory config doctor",
  ].join("\n");
}
