import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { resolveNodeRelPath } from "./paths.ts";

export interface ReadResult {
  rel: string;
  raw: string;
}

export async function readNode(repoRoot: string, brainId: string, input: string): Promise<ReadResult> {
  const rel = resolveNodeRelPath(repoRoot, brainId, input);
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, rel), "utf8");
  } catch {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `节点不存在: ${rel}`);
  }
  return { rel, raw };
}
