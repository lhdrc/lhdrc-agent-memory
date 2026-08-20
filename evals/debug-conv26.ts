/**
 * 定向调试：conv-26 capture 建仓 → 8 题检索原始 hits + 分数 + 黄金答案是否在库/命中。
 * 复刻 eval 的 capture+query 路径。输出：evals/cache/locomo/debug-conv26-retrieval.json
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureNode,
  hybridQuery,
  openPglite,
  resolveEmbedder,
} from "../packages/core/src/index.ts";
import { createEvalWorkspace } from "./lib/workspace.ts";
import { loadLocomoPublishFile } from "./adapters/locomo.ts";

// ---- .env 加载（同 run.ts）----
if (existsSync(".env")) {
  for (const raw of readFileSync(".env", "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const SAMPLE_ID = "conv-26";
const EMBED_MODEL = "Qwen/Qwen3-Embedding-8B";
const EMBED_DIMS = 4096;
const API_BASE = "https://api.siliconflow.cn";
const KEY_ENV = process.env.SILICONFLOW_API_KEY ? "SILICONFLOW_API_KEY" : "OPENAI_API_KEY";

function keyEnvVal(): string {
  return (process.env[KEY_ENV] ?? "").trim();
}

async function patchYml(repoRoot: string): Promise<void> {
  const path = join(repoRoot, "memory.yml");
  let yml = await readFile(path, "utf8");
  yml = yml.replace(/^llm:\n  provider: off/m, "llm:\n  provider: openai");
  yml = yml.replace(/^  model: text-embedding-3-small$/m, `  model: ${EMBED_MODEL}`);
  yml = yml.replace(/^  dims: 1536$/m, `  dims: ${EMBED_DIMS}`);
  yml = yml.replace(/^  base_url: https:\/\/api\.openai\.com$/m, `  base_url: ${API_BASE}`);
  yml = yml.replace(/^  openai_api_key_env: OPENAI_API_KEY$/gm, `  openai_api_key_env: ${KEY_ENV}`);
  yml = yml.replace(/^  distill: true$/m, "  distill: false");
  yml = yml.replace(/^    distill: false$/m, "    distill: true");
  yml = yml.replace(/^  lazy_min_sources: 5$/m, "  lazy_min_sources: 9999");
  yml = yml.replace(/^  auto_crystallize: true$/m, "  auto_crystallize: false");
  await writeFile(path, yml, "utf8");
}

async function countL0(repoRoot: string): Promise<number> {
  const root = join(repoRoot, "brains", "default", "sources");
  let n = 0;
  async function walk(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile() && e.name.endsWith(".md")) n++;
    }
  }
  await walk(root);
  return n;
}

async function readAllNotes(repoRoot: string): Promise<Array<{ path: string; body: string }>> {
  const out: Array<{ path: string; body: string }> = [];
  const root = join(repoRoot, "brains", "default", "sources");
  async function walk(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile() && e.name.endsWith(".md")) {
        out.push({ path: abs, body: await readFile(abs, "utf8") });
      }
    }
  }
  await walk(root);
  return out;
}

async function main(): Promise<void> {
  const key = keyEnvVal();
  if (!key) {
    console.error("缺少 SILICONFLOW_API_KEY，无法真实 embed");
    process.exit(1);
  }
  console.log(`KEY_ENV=${KEY_ENV}（前8位 ${key.slice(0, 8)}…）`);

  const samples = await loadLocomoPublishFile("evals/cache/locomo/data.json");
  const sample = samples.find((s) => s.sample_id === SAMPLE_ID);
  if (!sample) {
    console.error(`未找到 ${SAMPLE_ID}`);
    process.exit(1);
  }

  const ws = await createEvalWorkspace({ brain: "default", git: "off" });
  const embedder = resolveEmbedder({
    provider: "openai",
    model: EMBED_MODEL,
    dims: EMBED_DIMS,
    openai_api_key_env: KEY_ENV,
    base_url: API_BASE,
  }).embedder;
  console.log(`工作区 ${ws.repoRoot}`);

  try {
    await patchYml(ws.repoRoot);
    let notes = 0;
    for (const sess of sample.sessions) {
      let n = 0;
      for (const t of sess.turns) {
        n++;
        const title = `${sample.sample_id}-s${sess.index}-t${n}`;
        await captureNode(ws.repoRoot, ws.pack, ws.queue, {
          brainId: "default",
          sourceId: "default",
          schemaType: "note",
          title,
          body: t.text,
          createdBy: `debug:locomo:${sample.sample_id}`,
        });
        notes++;
        if (n % 10 === 0 || n === sess.turns.length) {
          console.log(`[progress] capture s${sess.index} ${n}/${sess.turns.length} 轮，累计 ${notes}`);
        }
      }
    }
    const l0 = await countL0(ws.repoRoot);
    console.log(`capture 完成：${sample.sessions.length} sessions / ${notes} notes / L0=${l0}`);

    const allNotes = await readAllNotes(ws.repoRoot);
    const conn = await openPglite(ws.repoRoot);

    const questions = sample.qa.slice(0, 8);
    const results: unknown[] = [];

    for (const qa of questions) {
      const q = qa.question;
      const golds = Array.isArray(qa.answer) ? qa.answer : [String(qa.answer)];
      const goldLower = golds.map((g) => g.toLowerCase());
      const goldParts = golds.map((g) => g.toLowerCase());

      const hits = await hybridQuery(conn.db, {
        brainId: "default",
        query: q,
        skipCache: true,
        limit: 30,
        mode: "balanced",
        embedder,
        repoRoot: ws.repoRoot,
        excludeSchemaTypes: ["skill"],
        excludeSidecars: true,
      });

      const kbHits = allNotes.filter((n) =>
        goldParts.some((g) => n.body.toLowerCase().includes(g)),
      );
      const hitContainsGold = hits.filter((h) =>
        goldParts.some((g) => h.snippet.toLowerCase().includes(g) || h.title.toLowerCase().includes(g)),
      );

      results.push({
        question: q,
        category: qa.category,
        gold: golds,
        gold_in_kb: kbHits.length > 0,
        kb_matching_notes: kbHits.map((n) => n.path.replace(ws.repoRoot, "<ws>")),
        n_hits: hits.length,
        hits: hits.map((h) => ({
          path: h.path.replace(ws.repoRoot, "<ws>"),
          score: Number(h.score.toFixed(4)),
          schema_type: h.schema_type,
          snippet: (h.snippet ?? "").slice(0, 220),
        })),
        gold_in_top_hits: hitContainsGold.map((h) => h.path.replace(ws.repoRoot, "<ws>")),
      });
      console.log(
        `Q[${qa.category}] ${q.slice(0, 60)} → hits=${hits.length} gold_in_kb=${kbHits.length > 0} gold_in_hits=${hitContainsGold.length}`,
      );
    }

    await conn.close();
    await mkdir("evals/cache/locomo", { recursive: true });
    await writeFile(
      "evals/cache/locomo/debug-conv26-retrieval.json",
      JSON.stringify({ sample_id: SAMPLE_ID, l0, results }, null, 2),
      "utf8",
    );
    console.log("已写入 evals/cache/locomo/debug-conv26-retrieval.json");
  } finally {
    await ws.dispose();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});