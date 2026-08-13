import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { parseFrontmatter } from "../frontmatter.ts";
import { heuristicAbstract, heuristicOverview, overviewSidecarRel } from "../layers/generate.ts";
import { resolveNodeRelPath } from "./paths.ts";

export type MemoryLayer = "l0" | "l1" | "l2";

export interface ReadResult {
  rel: string;
  raw: string;
  layer: MemoryLayer;
  content: string;
  chars: number;
}

export function parseMemoryLayer(raw: unknown): MemoryLayer {
  const v = String(raw ?? "l2").toLowerCase();
  if (v === "l0" || v === "l1" || v === "l2") return v;
  throw new MemoryError(ErrorCodes.USAGE, `--layer 必须是 l0|l1|l2，收到: ${String(raw)}`);
}

export async function readNode(
  repoRoot: string,
  brainId: string,
  input: string,
  opts?: { layer?: MemoryLayer },
): Promise<ReadResult> {
  const layer = opts?.layer ?? "l2";
  const rel = resolveNodeRelPath(repoRoot, brainId, input);
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, rel), "utf8");
  } catch {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `节点不存在: ${rel}`);
  }

  let content: string;
  if (layer === "l2") {
    content = raw;
  } else if (layer === "l0") {
    const { data, body } = parseFrontmatter(raw);
    const a = typeof data.abstract === "string" ? data.abstract.trim() : "";
    content = a || heuristicAbstract(body);
  } else {
    const { data, body } = parseFrontmatter(raw);
    const sidecarHint = typeof data.overview_sidecar === "string" ? data.overview_sidecar : overviewSidecarRel(rel);
    let sidecarText = "";
    try {
      sidecarText = await readFile(join(repoRoot, sidecarHint), "utf8");
    } catch {
      sidecarText = "";
    }
    const o = typeof data.overview === "string" ? data.overview.trim() : "";
    content = sidecarText.trim() || o || heuristicOverview(body);
  }

  return { rel, raw, layer, content, chars: content.length };
}
