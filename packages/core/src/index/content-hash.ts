/**
 * P9.1：索引 content_hash 只吃语义稳定字段，时间戳不进 hash。
 */
import { parseFrontmatter } from "../frontmatter.ts";
import { sha256Hex } from "../util/hash.ts";

/** 易变键：不进 hash（即使出现在白名单外也剔除） */
const VOLATILE_KEYS = new Set([
  "created_at",
  "captured_at",
  "updated_at",
  "created_by",
  "version",
]);

/**
 * 语义白名单。数组（facts/links/tags/aliases）保持文件顺序。
 * 实体 redirect / merged_* 必须进 hash。
 */
const SEMANTIC_KEYS = [
  "title",
  "schema_type",
  "status",
  "source",
  "tags",
  "aliases",
  "links",
  "facts",
  "slug",
  "redirect",
  "merged_at",
  "merged_by",
  "external_ids",
] as const;

function stableSerialize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableSerialize(obj[k])}`).join(",")}}`;
}

export function pickSemanticFrontmatter(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SEMANTIC_KEYS) {
    if (!(key in data) || VOLATILE_KEYS.has(key)) continue;
    out[key] = data[key];
  }
  return out;
}

/** 对 md 原文计算语义 content_hash（SHA-256 hex）。 */
export function semanticContentHash(raw: string): string {
  const { data, body } = parseFrontmatter(raw);
  const semantic = pickSemanticFrontmatter(data);
  return sha256Hex(`${stableSerialize(semantic)}\n${body}`);
}
