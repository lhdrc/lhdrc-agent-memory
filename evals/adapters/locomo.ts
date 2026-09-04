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

export interface LocomoTurn {
  session: string;
  ts: string;
  speaker: string;
  diaId: string;
  text: string;
}

export interface LocomoSampleDetailed {
  sampleId: string;
  turns: LocomoTurn[];
  observations: Array<{ session: string; text: string }>;
  cases: EvalCase[];
}

function turnsFromConversationDetailed(conv: Record<string, unknown> | undefined): LocomoTurn[] {
  if (!conv) return [];
  const out: LocomoTurn[] = [];
  for (const [k, v] of Object.entries(conv)) {
    const m = k.match(/^session_(\d+)$/);
    if (!m || !Array.isArray(v)) continue;
    const ts = String((conv as Record<string, unknown>)[`session_${m[1]}_date_time`] ?? "");
    for (const raw of v) {
      const t = raw as { speaker?: string; dia_id?: string; text?: string };
      const text = String(t.text ?? "").trim();
      if (!text) continue;
      out.push({ session: `session_${m[1]}`, ts, speaker: String(t.speaker ?? "speaker"), diaId: String(t.dia_id ?? ""), text });
    }
  }
  return out;
}

export function parseLocomoDetailed(data: unknown): { samples: LocomoSampleDetailed[] } {
  const raws: LocomoSample[] = Array.isArray(data) ? data : [data as LocomoSample];
  return {
    samples: raws.map((s, si) => {
      const conv = s.conversation as Record<string, unknown> | undefined;
      const turns = turnsFromConversationDetailed(conv);
      const obs = (s as { observation?: Record<string, string> }).observation ?? {};
      const observations = Object.entries(obs)
        .filter(([, v]) => String(v ?? "").trim())
        .map(([k, v]) => ({ session: k, text: String(v) }));
      const cases: EvalCase[] = (s.qa ?? []).flatMap((qa, i) => {
        const query = String(qa.question ?? "").trim();
        return query
          ? [{ id: `${s.sample_id ?? `sample${si}`}-q${i}`, query, gold: qa.answer ?? "", evidence: qa.evidence, ingestTexts: [], meta: { category: qa.category, sample_id: s.sample_id, dia_ids: qa.evidence } }]
          : [];
      });
      return { sampleId: String(s.sample_id ?? `sample${si}`), turns, observations, cases };
    }),
  };
}

export function locomoBrainFor(sampleId: string): string {
  return `locomo-${sampleId}`;
}

export function formatLocomoTurn(t: LocomoTurn): string {
  const when = t.ts ? `[${t.ts}] ` : "";
  const dia = t.diaId ? `[${t.diaId}] ` : "";
  return `${when}${dia}${t.speaker}: ${t.text}`;
}

const MISSING =
  "LoCoMo 数据未准备。请使用 --fixture 跑仓内样例，或执行 memory eval fetch --adapter locomo --allow-net";

export const locomoAdapter: EvalAdapter = {
  id: "locomo",
  async load(opts: AdapterLoadOptions): Promise<EvalCase[]> {
    let raw: unknown;
    if (opts.fixture) {
      const p = join(opts.fixtureDir, "sample.json");
      if (!existsSync(p)) {
        throw new Error(`缺少 locomo fixture（${p}）。使用 --fixture 或 fetch --allow-net`);
      }
      raw = JSON.parse(await readFile(p, "utf8"));
    } else {
      const cached = join(opts.cacheDir, "data.json");
      if (!existsSync(cached)) {
        throw new Error(MISSING);
      }
      raw = JSON.parse(await readFile(cached, "utf8"));
    }
    const { samples } = parseLocomoDetailed(raw);
    const out: EvalCase[] = [];
    for (const s of samples) {
      const brain = locomoBrainFor(s.sampleId);
      const ingestTexts = s.turns.map(formatLocomoTurn);
      for (const o of s.observations) {
        ingestTexts.push(`[observation][${o.session}]\n${o.text}`);
      }
      for (const c of s.cases) {
        c.meta = { ...(c.meta ?? {}), brain };
        c.ingestTexts = ingestTexts;
        out.push(c);
      }
    }
    return out;
  },
  score(output: unknown, gold: unknown): number {
    const blob = typeof output === "string" ? output : JSON.stringify(output ?? "");
    return goldHit(blob, gold as string | string[]) ? 1 : 0;
  },
};
