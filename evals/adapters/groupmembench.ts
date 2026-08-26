import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EvalAdapter, EvalCase, AdapterLoadOptions } from "./types.ts";
import { goldHit } from "../lib/rule-agent.ts";
import { parseJsonl } from "../lib/jsonl.ts";
import { readFile } from "node:fs/promises";

interface GmbMessage {
  msg_node?: string;
  content?: string;
  author?: string;
  role?: string;
  timestamp?: string;
  is_noise?: boolean;
}

interface GmbQuestion {
  id?: string;
  question?: string;
  answer?: string;
  asking_user_id?: string;
}

function formatMessage(m: GmbMessage): string {
  const author = String(m.author ?? "user");
  const role = String(m.role ?? "");
  const ts = String(m.timestamp ?? "");
  const body = String(m.content ?? "").trim();
  const who = role ? `${author} (${role})` : author;
  const when = ts ? `[${ts}] ` : "";
  return `${when}${who}: ${body}`;
}

function ingestFromChannels(channels: Record<string, unknown>): string[] {
  const texts: string[] = [];
  for (const [channel, raw] of Object.entries(channels)) {
    if (!Array.isArray(raw)) continue;
    for (const item of raw) {
      const m = item as GmbMessage;
      const line = formatMessage(m);
      if (!line.trim() || line.endsWith(":")) continue;
      texts.push(`#${channel}\n${line}`);
    }
  }
  return texts;
}

function parseQuestions(rows: unknown[], ingestTexts: string[]): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const raw of rows) {
    const q = raw as GmbQuestion;
    const query = String(q.question ?? "").trim();
    if (!query) continue;
    cases.push({
      id: String(q.id ?? `q${cases.length}`),
      query,
      gold: String(q.answer ?? "").trim(),
      ingestTexts,
      meta: { asking_user_id: q.asking_user_id, qtype: process.env.DF_EVAL_GMB_QTYPE ?? "knowledge_update" },
    });
  }
  return cases;
}

const MISSING =
  "GroupMemBench 数据未准备。请使用 --fixture 跑仓内样例，或执行 memory eval fetch --adapter groupmembench --allow-net";

export const groupmembenchAdapter: EvalAdapter = {
  id: "groupmembench",
  async load(opts: AdapterLoadOptions): Promise<EvalCase[]> {
    if (opts.fixture) {
      const channelsPath = join(opts.fixtureDir, "channels.json");
      const questionsPath = join(opts.fixtureDir, "questions.jsonl");
      if (!existsSync(channelsPath) || !existsSync(questionsPath)) {
        throw new Error(`缺少 groupmembench fixture（${opts.fixtureDir}）。使用 --fixture 或 fetch --allow-net`);
      }
      const channels = JSON.parse(await readFile(channelsPath, "utf8")) as Record<string, unknown>;
      const ingestTexts = ingestFromChannels(channels);
      const rows = parseJsonl(await readFile(questionsPath, "utf8"));
      return parseQuestions(rows, ingestTexts);
    }
    const domain = process.env.DF_EVAL_GMB_DOMAIN?.trim() || "Technology";
    const qtype = process.env.DF_EVAL_GMB_QTYPE?.trim() || "knowledge_update";
    const channelsPath = join(opts.cacheDir, domain, "channels.json");
    const questionsPath = join(opts.cacheDir, domain, `${qtype}.jsonl`);
    if (!existsSync(channelsPath) || !existsSync(questionsPath)) {
      throw new Error(MISSING);
    }
    const channels = JSON.parse(await readFile(channelsPath, "utf8")) as Record<string, unknown>;
    const ingestTexts = ingestFromChannels(channels);
    const rows = parseJsonl(await readFile(questionsPath, "utf8"));
    return parseQuestions(rows, ingestTexts);
  },
  score(output: unknown, gold: unknown): number {
    const blob = typeof output === "string" ? output : JSON.stringify(output ?? "");
    return goldHit(blob, gold as string | string[]) ? 1 : 0;
  },
};
