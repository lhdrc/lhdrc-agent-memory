import { mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { loadPack } from "../schema/loadPack.ts";
import { gitInit, gitAddAll, gitCommit, ensureGitIdentity } from "./git.ts";

export interface InitOptions {
  brain: string;
  source: string;
  force: boolean;
}

export function memoryYml(brain: string, schemaPack: string): string {
  return `version: 1
brain_id: ${brain}
schema_pack: ${schemaPack}
git:
  auto_commit: true
  commit_prefix: "memory:"
index:
  engine: pglite
  path: .dfmemory/pglite
writer:
  lock_file: .dfmemory/write.lock
  lock_timeout_ms: 30000
`;
}

export function brainYml(brain: string, schemaPack: string, source: string): string {
  return `id: ${brain}
name: ${brain}
schema_pack: ${schemaPack}
sources:
  default: ${source}
created_at: "${new Date().toISOString()}"
`;
}

export function sourceMarker(sourceId: string, brainId: string): string {
  return `source_id: ${sourceId}\nbrain_id: ${brainId}\n`;
}

export const INITIAL_CREATED_PATHS = [
  "memory.yml",
  ".gitignore",
  ".dfmemory",
  "brains",
] as const;

export async function initMemoryRepo(dir: string, opts: InitOptions): Promise<string> {
  const abs = resolve(dir);
  const existed = existsSync(abs);
  if (existed && !opts.force) {
    const entries = await readdir(abs);
    if (entries.length > 0) {
      throw new MemoryError(ErrorCodes.USAGE, `目录非空: ${abs}（使用 --force 强制初始化）`);
    }
  }

  const pack = await loadPack("problem-tree");
  await mkdir(abs, { recursive: true });

  try {
    await writeFile(join(abs, "memory.yml"), memoryYml(opts.brain, pack.id));
    await writeFile(
      join(abs, ".gitignore"),
      ".dfmemory/pglite/\n.dfmemory/write.lock\n.dfmemory/index-meta.json\n",
    );

    await mkdir(join(abs, ".dfmemory", "logs"), { recursive: true });
    await writeFile(
      join(abs, ".dfmemory", "index-meta.json"),
      JSON.stringify({ schemaVersion: 1, lastSyncAt: null, fileCount: 0 }, null, 2),
    );

    const brainRoot = join(abs, "brains", opts.brain);
    await mkdir(join(brainRoot, "sources", opts.source), { recursive: true });
    await writeFile(join(brainRoot, "brain.yml"), brainYml(opts.brain, pack.id, opts.source));
    await writeFile(join(brainRoot, "sources", opts.source, ".dfmemory-source"), sourceMarker(opts.source, opts.brain));

    for (const d of pack.directories_on_init ?? []) {
      const p = d.replace(/^sources\/default/, `sources/${opts.source}`);
      await mkdir(join(brainRoot, p), { recursive: true });
    }
    for (const d of ["entities", "events", "experiences", "skills"]) {
      await mkdir(join(brainRoot, d), { recursive: true });
    }
    await writeFile(join(brainRoot, "contradictions.md"), "# Contradictions\n");

    await gitInit(abs);
    await ensureGitIdentity(abs);
    await gitAddAll(abs);
    await gitCommit(abs, `memory: init brain ${opts.brain}`);
  } catch (e) {
    if (!existed || opts.force) {
      await rm(join(abs, "memory.yml"), { force: true }).catch(() => {});
      await rm(join(abs, ".gitignore"), { force: true }).catch(() => {});
      await rm(join(abs, ".dfmemory"), { recursive: true, force: true }).catch(() => {});
      await rm(join(abs, "brains"), { recursive: true, force: true }).catch(() => {});
      if (!existed) {
        await rm(abs, { recursive: true, force: true }).catch(() => {});
      }
    }
    throw e;
  }
  return abs;
}
