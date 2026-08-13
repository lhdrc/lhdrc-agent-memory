import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EvalAdapter, EvalCase, AdapterLoadOptions } from "./types.ts";
import { goldHit } from "../lib/rule-agent.ts";

interface LocomoTurn {
  speaker?: string;
  text?: string;
}

interface LocomoSample {
  sample_id?: string;
  conversation?: Record<string, unknown>;
  qa?: Array<{ question?: string; answer?: string | string[]; evidence?: string[]; category?: number }>;
}

function turnsFromConversation(conv: Record<string, unknown> | undefined): string[] {
  if (!conv) return [];
  const texts: string[] = [];
  for (const [k, v] of Object.entries(conv)) {
    if (!/^session_\d+$/.test(k) || !Array.isArray(v)) continue;
    for (const raw of v) {
      const t = raw as LocomoTurn;
      const text = String(t.text ?? "").trim();
      if (!text) continue;
      const speaker = String(t.speaker ?? "speaker");
      texts.push(`${speaker}: ${text}`);
    }
  }
  return texts;
}

function parseLocomo(data: unknown): EvalCase[] {
  const samples: LocomoSample[] = Array.isArray(data) ? data : [data as LocomoSample];
  const cases: EvalCase[] = [];
  for (const sample of samples) {
    const ingestTexts = turnsFromConversation(sample.conversation);
    const qas = sample.qa ?? [];
    let i = 0;
    for (const qa of qas) {
      const query = String(qa.question ?? "").trim();
      if (!query) continue;
      const gold = qa.answer ?? "";
      cases.push({
        id: `${sample.sample_id ?? "sample"}-q${i++}`,
        query,
        gold,
        evidence: qa.evidence,
        ingestTexts,
        meta: { category: qa.category, sample_id: sample.sample_id },
      });
    }
  }
  return cases;
}

const MISSING =
  "LoCoMo 数据未准备。请使用 --fixture 跑仓内样例，或执行 memory eval fetch --adapter locomo --allow-net";

export const locomoAdapter: EvalAdapter = {
  id: "locomo",
  async load(opts: AdapterLoadOptions): Promise<EvalCase[]> {
    if (opts.fixture) {
      const p = join(opts.fixtureDir, "sample.json");
      if (!existsSync(p)) {
        throw new Error(`缺少 locomo fixture（${p}）。使用 --fixture 或 fetch --allow-net`);
      }
      return parseLocomo(JSON.parse(await readFile(p, "utf8")));
    }
    const cached = join(opts.cacheDir, "data.json");
    if (!existsSync(cached)) {
      throw new Error(MISSING);
    }
    return parseLocomo(JSON.parse(await readFile(cached, "utf8")));
  },
  score(output: unknown, gold: unknown): number {
    const blob = typeof output === "string" ? output : JSON.stringify(output ?? "");
    return goldHit(blob, gold as string | string[]) ? 1 : 0;
  },
};
