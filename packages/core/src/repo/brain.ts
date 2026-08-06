import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { MemoryError, ErrorCodes } from "../errors.ts";

export interface BrainConfig {
  id: string;
  name: string;
  schema_pack: string;
  sources: Record<string, string>;
  created_at: string;
}

export async function loadBrainConfig(repoRoot: string, brainId: string): Promise<BrainConfig> {
  const file = join(repoRoot, "brains", brainId, "brain.yml");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `brain 不存在: ${brainId} (${file})`);
  }
  const data = (parseYaml(raw) ?? {}) as Record<string, any>;
  return {
    id: data.id ?? brainId,
    name: data.name ?? brainId,
    schema_pack: data.schema_pack ?? "problem-tree",
    sources: data.sources ?? { default: "default" },
    created_at: data.created_at ?? "",
  };
}

export function resolveSourceId(brain: BrainConfig): string {
  return brain.sources?.default ?? "default";
}
