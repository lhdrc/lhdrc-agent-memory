import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Turn } from "../../packages/core/src/index.ts";
import type { EvalAdapter, EvalCase, AdapterLoadOptions } from "./types.ts";
import { goldHit } from "../lib/rule-agent.ts";

export const LOCOMO_SCORE_CATEGORIES = [1, 2, 3, 4] as const;
export type LocomoScoreCategory = (typeof LOCOMO_SCORE_CATEGORIES)[number];

/** JSON category id → 业界口径（非论文正文顺序）。 */
export const LOCOMO_CATEGORY_NAMES: Record<number, string> = {
  1: "multi-hop",
  2: "temporal",
  3: "open-domain",
  4: "single-hop",
  5: "adversarial",
};

export function isScoreCategory(n: number): n is LocomoScoreCategory {
  return n === 1 || n === 2 || n === 3 || n === 4;
}

interface LocomoTurn {
  speaker?: string;
  text?: string;
  dia_id?: string;
}

export interface LocomoQa {
  question: string;
  answer: string | string[];
  evidence?: string[];
  category: number;
  index: number;
}

export interface LocomoSession {
  index: number;
  dateTime?: string;
  turns: Turn[];
}

export interface LocomoPublishSample {
  sample_id: string;
  sessions: LocomoSession[];
  qa: LocomoQa[];
}

interface LocomoRaw {
  sample_id?: string;
  conversation?: Record<string, unknown>;
  qa?: Array<{ question?: string; answer?: string | string[]; evidence?: string[]; category?: number }>;
}

function asSamples(data: unknown): LocomoRaw[] {
  return Array.isArray(data) ? (data as LocomoRaw[]) : [data as LocomoRaw];
}

export function sessionsFromConversation(conv: Record<string, unknown> | undefined): LocomoSession[] {
  if (!conv) return [];
  const speakerA = String(conv.speaker_a ?? "").trim();
  const speakerB = String(conv.speaker_b ?? "").trim();
  const indices = new Set<number>();
  for (const k of Object.keys(conv)) {
    const m = /^session_(\d+)$/.exec(k);
    if (m) indices.add(Number(m[1]));
  }
  const ordered = [...indices].sort((a, b) => a - b);
  const sessions: LocomoSession[] = [];
  for (const index of ordered) {
    const raw = conv[`session_${index}`];
    if (!Array.isArray(raw)) continue;
    const dateTime = conv[`session_${index}_date_time`] != null ? String(conv[`session_${index}_date_time`]) : undefined;
    const turns: Turn[] = [];
    for (const row of raw) {
      const t = row as LocomoTurn;
      const text = String(t.text ?? "").trim();
      if (!text) continue;
      const speaker = String(t.speaker ?? "speaker").trim() || "speaker";
      let role: Turn["role"] = "assistant";
      if (speakerA && speaker === speakerA) role = "user";
      else if (speakerB && speaker === speakerB) role = "assistant";
      else if (!speakerA) role = turns.length % 2 === 0 ? "user" : "assistant";
      const prefixed = `${speaker}: ${text}`;
      const at = parseLocomoDate(dateTime);
      turns.push(at ? { role, text: prefixed, at } : { role, text: prefixed });
    }
    if (dateTime && turns[0] && !turns[0].at) {
      turns[0] = { ...turns[0], text: `[Session time: ${dateTime}] ${turns[0].text}` };
    }
    if (turns.length) sessions.push({ index, dateTime, turns });
  }
  return sessions;
}

function parseLocomoDate(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

export function parseLocomoPublish(data: unknown): LocomoPublishSample[] {
  const out: LocomoPublishSample[] = [];
  for (const sample of asSamples(data)) {
    const sample_id = String(sample.sample_id ?? "sample");
    const sessions = sessionsFromConversation(sample.conversation);
    const qa: LocomoQa[] = [];
    let i = 0;
    for (const row of sample.qa ?? []) {
      const question = String(row.question ?? "").trim();
      if (!question) continue;
      const category = Number(row.category ?? 0);
      qa.push({
        question,
        answer: row.answer ?? "",
        evidence: row.evidence,
        category,
        index: i++,
      });
    }
    out.push({ sample_id, sessions, qa });
  }
  return out;
}

function parseLocomo(data: unknown): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const sample of parseLocomoPublish(data)) {
    const texts: string[] = [];
    for (const s of sample.sessions) {
      for (const t of s.turns) texts.push(t.text);
    }
    for (const qa of sample.qa) {
      cases.push({
        id: `${sample.sample_id}-q${qa.index}`,
        query: qa.question,
        gold: qa.answer,
        evidence: qa.evidence,
        ingestTexts: texts,
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

export async function loadLocomoPublishFile(path: string): Promise<LocomoPublishSample[]> {
  if (!existsSync(path)) {
    throw new Error(MISSING);
  }
  return parseLocomoPublish(JSON.parse(await readFile(path, "utf8")));
}
