import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { KNOWN_LINK_TYPES } from "../graph/link-extraction.ts";
import { packageRootFrom } from "../util/here.ts";

export const DEFAULT_PACK = "problem-tree";

export const PACKS_DIR = join(packageRootFrom(import.meta.url), "schema-packs");

export interface ExtraVerbRaw {
  pattern: string;
  type: string;
}

export interface SchemaPack {
  id: string;
  version: number;
  description?: string;
  schema_types: string[];
  merge_op: Record<string, string>;
  filename_templates: Record<string, string>;
  n_start: number;
  intent_lexicon?: Record<string, string[]>;
  directories_on_init?: string[];
  /** P10.2：pack 级额外动词；非法行在 compileExtraVerbs 丢弃 */
  extra_verbs?: ExtraVerbRaw[];
}

/** P10.2：编译 pack extra_verbs；非法 type / 危险正则丢弃该行。 */
export function compileExtraVerbs(raw: ExtraVerbRaw[] | undefined): Array<{ re: RegExp; type: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ re: RegExp; type: string }> = [];
  for (const row of raw) {
    if (!row || typeof row.pattern !== "string" || typeof row.type !== "string") continue;
    const type = row.type.trim().toLowerCase();
    if (!KNOWN_LINK_TYPES.has(type)) continue;
    const pattern = row.pattern.trim();
    if (!pattern || pattern.length > 64) continue;
    if (pattern.includes("(?=")) continue;
    if (/\{\d+,\}/.test(pattern)) {
      let skip = false;
      for (const m of pattern.matchAll(/\{(\d+),\}/g)) {
        const n = Number.parseInt(m[1] ?? "0", 10);
        if (n > 32) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
    }
    try {
      out.push({ re: new RegExp(pattern, "i"), type });
    } catch {
      /* 编译失败丢弃 */
    }
  }
  return out;
}

/**
 * 剥离 markdown 代码围栏（spec 中的 pack 文件用 ```yaml 包裹，且前面有注释头）。
 * 按行定位 ```yaml/```yml 围栏块；无围栏时直接整体解析。
 */
export function stripYamlFence(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const openIdx = lines.findIndex((l) => /^```(?:yaml|yml)\s*$/.test(l.trim()));
  if (openIdx === -1) return raw;
  const closeIdx = lines.findIndex((l, i) => i > openIdx && /^```\s*$/.test(l.trim()));
  if (closeIdx === -1) return lines.slice(openIdx + 1).join("\n");
  return lines.slice(openIdx + 1, closeIdx).join("\n");
}

export async function loadPack(packId: string = DEFAULT_PACK): Promise<SchemaPack> {
  const isPath = packId.includes("/") || packId.includes("\\") || /\.ya?ml$/.test(packId);
  const file = isPath ? packId : join(PACKS_DIR, `${packId}.yml`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `schema pack 不存在: ${packId}`);
  }
  const data = parseYaml(stripYamlFence(raw)) as SchemaPack;
  if (!data || typeof data.id !== "string" || !Array.isArray(data.schema_types) || data.schema_types.length === 0) {
    throw new MemoryError(ErrorCodes.INTERNAL, `schema pack 无效: ${packId}`);
  }
  return data;
}
