/**
 * 分区 ingest checkpoint：连续区间 + 每区独立进度文件。
 * 仅在窗 compile / endSession 成功后推进 next，支持断点续跑。
 */
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface IngestPartitionRange {
  part: number;
  start: number;
  end: number; // exclusive
}

export interface IngestPartCheckpoint {
  part: number;
  start: number;
  end: number;
  /** 下一条待处理的全局下标（[start,end) 内） */
  next: number;
  compiles: number;
  kept: number;
  done: boolean;
  updated_at: string;
}

export interface IngestCheckpointManifest {
  version: 1;
  adapter: string;
  total: number;
  concurrency: number;
  created_at: string;
  updated_at: string;
}

function checkpointDir(repoRoot: string): string {
  return join(repoRoot, ".dfmemory", "eval-ingest");
}

export function partitionRanges(total: number, parts: number): IngestPartitionRange[] {
  const n = Math.max(1, parts);
  const out: IngestPartitionRange[] = [];
  const base = Math.floor(total / n);
  let rem = total % n;
  let start = 0;
  for (let i = 0; i < n; i++) {
    const size = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem -= 1;
    const end = Math.min(total, start + size);
    if (start < end) out.push({ part: i, start, end });
    start = end;
  }
  return out;
}

export async function loadOrInitManifest(
  repoRoot: string,
  opts: { adapter: string; total: number; concurrency: number; reset: boolean },
): Promise<IngestCheckpointManifest> {
  const dir = checkpointDir(repoRoot);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "manifest.json");
  if (!opts.reset && existsSync(path)) {
    const raw = JSON.parse(await readFile(path, "utf8")) as IngestCheckpointManifest;
    if (raw.total === opts.total && raw.concurrency === opts.concurrency && raw.adapter === opts.adapter) {
      return raw;
    }
    console.error(
      `[eval] checkpoint manifest mismatch (total/concurrency/adapter)；将重建分区进度`,
    );
  }
  const now = new Date().toISOString();
  const manifest: IngestCheckpointManifest = {
    version: 1,
    adapter: opts.adapter,
    total: opts.total,
    concurrency: opts.concurrency,
    created_at: now,
    updated_at: now,
  };
  await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
  // 清掉旧 part 文件
  for (let i = 0; i < 64; i++) {
    const p = join(dir, `part-${i}.json`);
    if (existsSync(p)) await unlink(p).catch(() => {});
  }
  return manifest;
}

export async function loadPartCheckpoint(
  repoRoot: string,
  range: IngestPartitionRange,
  reset: boolean,
): Promise<IngestPartCheckpoint> {
  const path = join(checkpointDir(repoRoot), `part-${range.part}.json`);
  if (!reset && existsSync(path)) {
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as IngestPartCheckpoint;
      if (
        raw &&
        raw.part === range.part &&
        raw.start === range.start &&
        raw.end === range.end &&
        typeof raw.next === "number"
      ) {
        return raw;
      }
    } catch {
      /* rebuild */
    }
  }
  return {
    part: range.part,
    start: range.start,
    end: range.end,
    next: range.start,
    compiles: 0,
    kept: 0,
    done: range.start >= range.end,
    updated_at: new Date().toISOString(),
  };
}

export async function savePartCheckpoint(
  repoRoot: string,
  cp: IngestPartCheckpoint,
): Promise<void> {
  const dir = checkpointDir(repoRoot);
  await mkdir(dir, { recursive: true });
  const next: IngestPartCheckpoint = { ...cp, updated_at: new Date().toISOString() };
  await writeFile(join(dir, `part-${cp.part}.json`), JSON.stringify(next, null, 2), "utf8");
}
