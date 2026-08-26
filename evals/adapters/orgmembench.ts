import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { EvalAdapter, EvalCase, AdapterLoadOptions } from "./types.ts";
import { goldHit } from "../lib/rule-agent.ts";
import { flattenGold, parseJsonl } from "../lib/jsonl.ts";

interface OrgIndexRow {
  slot_id?: string;
  path?: string;
  genre?: string;
  author?: string;
  role?: string;
  event_id?: string;
}

interface OrgQuestion {
  id?: string;
  category?: string;
  text?: string;
  ground_truth_answer?: unknown;
  evidence_artefact_ids?: string[];
  evidence_artifact_ids?: string[];
}

interface OrgArtifactInline {
  slot_id?: string;
  text?: string;
  timestamp?: string;
  author?: string;
  source_type?: string;
}

function formatArtifact(opts: { id: string; author?: string; genre?: string; ts?: string; text: string }): string {
  const bits = [`[${opts.id}]`];
  if (opts.genre) bits.push(opts.genre);
  if (opts.author) bits.push(opts.author);
  if (opts.ts) bits.push(opts.ts);
  return `${bits.join(" ")}\n${opts.text}`;
}

async function ingestFromIndex(cacheDir: string, rows: OrgIndexRow[]): Promise<string[]> {
  const texts: string[] = [];
  for (const row of rows) {
    const rel = String(row.path ?? "").replace(/\\/g, "/");
    if (!rel) continue;
    const abs = join(cacheDir, rel);
    if (!existsSync(abs)) continue;
    const body = (await readFile(abs, "utf8")).trim();
    if (!body) continue;
    texts.push(
      formatArtifact({
        id: String(row.slot_id ?? rel),
        author: row.author,
        genre: row.genre,
        text: body,
      }),
    );
  }
  return texts;
}

function casesFromQuestions(rows: unknown[], ingestTexts: string[]): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const raw of rows) {
    const q = raw as OrgQuestion;
    const query = String(q.text ?? "").trim();
    if (!query) continue;
    const gold = flattenGold(q.ground_truth_answer);
    const evidence = q.evidence_artefact_ids ?? q.evidence_artifact_ids;
    cases.push({
      id: String(q.id ?? `q${cases.length}`),
      query,
      gold: gold.length ? gold : query,
      evidence,
      ingestTexts,
      meta: { category: q.category },
    });
  }
  return cases;
}

const MISSING =
  "OrgMemBench 数据未准备。请使用 --fixture 跑仓内样例，或执行 memory eval fetch --adapter orgmembench --allow-net";

export const orgmembenchAdapter: EvalAdapter = {
  id: "orgmembench",
  async load(opts: AdapterLoadOptions): Promise<EvalCase[]> {
    if (opts.fixture) {
      const artPath = join(opts.fixtureDir, "artifacts.jsonl");
      const qPath = join(opts.fixtureDir, "questions.jsonl");
      if (!existsSync(artPath) || !existsSync(qPath)) {
        throw new Error(`缺少 orgmembench fixture（${opts.fixtureDir}）。使用 --fixture 或 fetch --allow-net`);
      }
      const arts = parseJsonl(await readFile(artPath, "utf8")) as OrgArtifactInline[];
      const ingestTexts = arts
        .map((a) =>
          formatArtifact({
            id: String(a.slot_id ?? "art"),
            author: a.author,
            genre: a.source_type,
            ts: a.timestamp,
            text: String(a.text ?? "").trim(),
          }),
        )
        .filter((t) => t.trim());
      return casesFromQuestions(parseJsonl(await readFile(qPath, "utf8")), ingestTexts);
    }
    const benchPath = join(opts.cacheDir, "benchmark_v0.0.jsonl");
    const indexPath = join(opts.cacheDir, "corpus_index.jsonl");
    if (!existsSync(benchPath) || !existsSync(indexPath)) {
      throw new Error(MISSING);
    }
    const index = parseJsonl(await readFile(indexPath, "utf8")) as OrgIndexRow[];
    const ingestTexts = await ingestFromIndex(opts.cacheDir, index);
    return casesFromQuestions(parseJsonl(await readFile(benchPath, "utf8")), ingestTexts);
  },
  score(output: unknown, gold: unknown): number {
    const blob = typeof output === "string" ? output : JSON.stringify(output ?? "");
    const needles = Array.isArray(gold) ? gold : [String(gold ?? "")];
    return needles.some((g) => g && goldHit(blob, g)) ? 1 : 0;
  },
};
