import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

export interface DirtyState {
  paths: string[];
  /** 自上次 flush 以来成功写入次数（用于 batch_size） */
  writeCount: number;
  lastFlushAt: string | null;
  /** 本窗口首次 dirty 时间（用于 batch_interval） */
  firstDirtyAt: string | null;
}

export function dirtyPath(repoRoot: string): string {
  return join(repoRoot, ".dfmemory", "git-dirty.json");
}

export async function readDirtyState(repoRoot: string): Promise<DirtyState> {
  try {
    const raw = await readFile(dirtyPath(repoRoot), "utf8");
    const data = JSON.parse(raw) as Partial<DirtyState>;
    return {
      paths: Array.isArray(data.paths) ? [...new Set(data.paths.map(String))] : [],
      writeCount: typeof data.writeCount === "number" ? data.writeCount : 0,
      lastFlushAt: data.lastFlushAt ?? null,
      firstDirtyAt: data.firstDirtyAt ?? null,
    };
  } catch {
    return { paths: [], writeCount: 0, lastFlushAt: null, firstDirtyAt: null };
  }
}

export async function writeDirtyState(repoRoot: string, state: DirtyState): Promise<void> {
  const p = dirtyPath(repoRoot);
  await mkdir(dirname(p), { recursive: true });
  const normalized: DirtyState = {
    paths: [...new Set(state.paths)],
    writeCount: state.writeCount,
    lastFlushAt: state.lastFlushAt,
    firstDirtyAt: state.firstDirtyAt,
  };
  await writeFile(p, JSON.stringify(normalized, null, 2), "utf8");
}

export async function clearDirtyState(repoRoot: string, lastFlushAt: string): Promise<void> {
  await writeDirtyState(repoRoot, { paths: [], writeCount: 0, lastFlushAt, firstDirtyAt: null });
}

export async function addDirtyPaths(repoRoot: string, paths: string[]): Promise<DirtyState> {
  const state = await readDirtyState(repoRoot);
  const now = new Date().toISOString();
  state.paths = [...new Set([...state.paths, ...paths])];
  state.writeCount += 1;
  if (!state.firstDirtyAt) state.firstDirtyAt = now;
  await writeDirtyState(repoRoot, state);
  return state;
}

export async function removeDirtyPaths(repoRoot: string, paths: string[]): Promise<DirtyState> {
  const state = await readDirtyState(repoRoot);
  if (paths.length === 0) return state;
  const drop = new Set(paths);
  state.paths = state.paths.filter((p) => !drop.has(p));
  await writeDirtyState(repoRoot, state);
  return state;
}

export function dirtyFileExists(repoRoot: string): boolean {
  return existsSync(dirtyPath(repoRoot));
}
