import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { isSlug } from "../util/slug.ts";
import { loadPack } from "../schema/loadPack.ts";
import { loadRepoConfig } from "./config.ts";
import { brainYml, sourceMarker } from "./init.ts";

export interface BrainMount {
  type: string;
  path: string;
}

export interface BrainConfig {
  id: string;
  name: string;
  schema_pack: string;
  sources: Record<string, string>;
  created_at: string;
  mounts?: BrainMount[];
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
  const mounts: BrainMount[] | undefined = Array.isArray(data.mounts)
    ? data.mounts
        .filter((m: unknown) => m && typeof m === "object")
        .map((m: Record<string, unknown>) => ({
          type: String(m.type ?? ""),
          path: String(m.path ?? ""),
        }))
        .filter((m: BrainMount) => m.type && m.path)
    : undefined;
  return {
    id: data.id ?? brainId,
    name: data.name ?? brainId,
    schema_pack: data.schema_pack ?? "problem-tree",
    sources: data.sources ?? { default: "default" },
    created_at: data.created_at ?? "",
    mounts,
  };
}

export function resolveSourceId(brain: BrainConfig): string {
  return brain.sources?.default ?? "default";
}

export function hasSharedSkillsMount(brain: BrainConfig): boolean {
  return (brain.mounts ?? []).some((m) => m.type === "shared_skills");
}

export interface CreateBrainOptions {
  name?: string;
  source?: string;
  schemaPack?: string;
}

/** 在已有仓内新增 brain（不改 memory.yml brain_id）。 */
export async function createBrain(
  repoRoot: string,
  brainId: string,
  opts?: CreateBrainOptions,
): Promise<string> {
  if (!isSlug(brainId)) {
    throw new MemoryError(ErrorCodes.VALIDATION, `非法 brain id: ${brainId}`);
  }
  const brainRoot = join(repoRoot, "brains", brainId);
  if (existsSync(join(brainRoot, "brain.yml"))) {
    throw new MemoryError(ErrorCodes.CONFLICT, `brain 已存在: ${brainId}`);
  }

  const cfg = await loadRepoConfig(repoRoot);
  const packId = opts?.schemaPack ?? cfg.schema_pack;
  const pack = await loadPack(packId);
  const source = opts?.source ?? "default";
  if (!isSlug(source)) {
    throw new MemoryError(ErrorCodes.VALIDATION, `非法 source id: ${source}`);
  }

  await mkdir(join(brainRoot, "sources", source), { recursive: true });
  let yml = brainYml(brainId, pack.id, source);
  if (opts?.name && opts.name !== brainId) {
    yml = yml.replace(/^name: .*$/m, `name: ${opts.name}`);
  }
  await writeFile(join(brainRoot, "brain.yml"), yml);

  await writeFile(
    join(brainRoot, "sources", source, ".dfmemory-source"),
    sourceMarker(source, brainId),
  );

  for (const d of pack.directories_on_init ?? []) {
    const p = d.replace(/^sources\/default/, `sources/${source}`);
    await mkdir(join(brainRoot, p), { recursive: true });
  }
  for (const d of ["entities", "events", "experiences", "skills"]) {
    await mkdir(join(brainRoot, d), { recursive: true });
  }
  await writeFile(join(brainRoot, "contradictions.md"), "# Contradictions\n");

  // shared/skills 仓级目录（可选 mount）
  const sharedSkills = join(repoRoot, "shared", "skills");
  if (!existsSync(sharedSkills)) {
    await mkdir(sharedSkills, { recursive: true });
  }

  return brainId;
}

export async function listBrains(
  repoRoot: string,
): Promise<Array<{ id: string; name: string; schema_pack: string }>> {
  const root = join(repoRoot, "brains");
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const out: Array<{ id: string; name: string; schema_pack: string }> = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    try {
      const cfg = await loadBrainConfig(repoRoot, e.name);
      out.push({ id: cfg.id, name: cfg.name, schema_pack: cfg.schema_pack });
    } catch {
      /* skip broken */
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
