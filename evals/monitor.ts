/**
 * 测评进度监控：轮询最新 locomo run 的 state.json + qa.jsonl + 活动工作区。
 * 用法：bun evals/monitor.ts [间隔秒]   （默认 2s；Ctrl+C 退出）
 */
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const INTERVAL_MS = Math.max(500, (Number(process.argv[2]) || 2) * 1000);
const RUNS_DIR = join("evals", "cache", "locomo", "runs");

interface RunState {
  run_id: string;
  samples: Record<string, { status: string; n?: number; hits?: number; compile_sessions?: number; l0_written?: number }>;
}

async function latestRunDir(): Promise<string | null> {
  if (!existsSync(RUNS_DIR)) return null;
  const dirs = (await readdir(RUNS_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => join(RUNS_DIR, d.name));
  let latest: string | null = null;
  let latestMs = 0;
  for (const d of dirs) {
    const ms = (await stat(d)).mtimeMs;
    if (ms > latestMs) {
      latestMs = ms;
      latest = d;
    }
  }
  return latest;
}

async function activeWorkspaceNotes(): Promise<number> {
  const prefix = join(tmpdir(), "dfmem-eval-");
  let best = 0;
  let bestMs = 0;
  try {
    for (const name of await readdir(tmpdir())) {
      if (!name.startsWith("dfmem-eval-")) continue;
      const root = join(prefix, name);
      const notesDir = join(root, "brains", "default", "sources", "default", "notes");
      if (!existsSync(notesDir)) continue;
      const n = (await readdir(notesDir)).filter((f) => f.endsWith(".md")).length;
      const ms = (await stat(join(root, "memory.yml"))).mtimeMs;
      if (ms > bestMs) {
        bestMs = ms;
        best = n;
      }
    }
  } catch {
    /* ignore */
  }
  return best;
}

function parseQa(path: string): { n: number; hits: number; byCat: Record<string, { n: number; hits: number }> } {
  const out = { n: 0, hits: 0, byCat: {} as Record<string, { n: number; hits: number }> };
  if (!existsSync(path)) return out;
  const txt = readFileSync(path, "utf8");
  for (const line of txt.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { category: number; score: number };
      out.n++;
      if (row.score >= 1) out.hits++;
      const c = row.category;
      out.byCat[c] = out.byCat[c] ?? { n: 0, hits: 0 };
      out.byCat[c]!.n++;
      out.byCat[c]!.hits += row.score >= 1 ? 1 : 0;
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

async function snapshot(): Promise<string> {
  const runDir = await latestRunDir();
  if (!runDir) return "无 run 目录";
  const runId = runDir.split(/[\\/]/).pop()!;
  const state: RunState = JSON.parse(
    existsSync(join(runDir, "state.json")) ? await readFile(join(runDir, "state.json"), "utf8") : "{}",
  );
  const samples = Object.values(state.samples ?? {});
  const qaDone = samples.filter((s) => s.status === "qa_done").length;
  const failed = samples.filter((s) => s.status === "failed").length;
  const compiled = samples.filter((s) => s.status === "compiled").length;
  const active = samples.filter((s) => s.status === "failed" || s.status === "compiled").length;
  const qa = parseQa(join(runDir, "qa.jsonl"));
  const notes = await activeWorkspaceNotes();
  const catStr = Object.entries(qa.byCat)
    .map(([c, v]) => `cat${c}=${v.n>0?(v.hits/v.n).toFixed(2):"-"}(${v.hits}/${v.n})`)
    .join(" ");
  const errLines = Object.entries(state.samples ?? {})
    .filter(([, s]) => s.status === "failed" && "error" in s && (s as { error?: string }).error)
    .slice(-1)
    .map(([id, s]) => ` last_err=${id}: ${(s as { error: string }).error}`)
    .join("");

  return [
    new Date().toISOString().slice(11, 19),
    `run=${runId}`,
    `samples: qa_done=${qaDone} compiled=${compiled} failed=${failed} total=${samples.length}`,
    `questions: ${qa.n} scored, hits=${qa.hits} acc=${qa.n > 0 ? (qa.hits / qa.n).toFixed(4) : "-"} ${catStr}`,
    `active_ws_notes=${notes}${errLines}`,
  ].join(" | ");
}

let last = "";
async function loop(): Promise<void> {
  for (;;) {
    const line = await snapshot();
    if (line !== last) {
      console.log(line);
      last = line;
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

loop().catch((e) => {
  console.error(e);
  process.exit(1);
});