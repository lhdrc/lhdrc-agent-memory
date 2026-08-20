import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Turn } from "../../packages/core/src/index.ts";
import { goldHit } from "../lib/rule-agent.ts";

export const HALUMEM_MEDIUM_URL =
  process.env.DF_EVAL_HALUMEM_URL?.trim() ||
  "https://huggingface.co/datasets/IAAR-Shanghai/HaluMem/resolve/main/HaluMem-Medium.jsonl";

export interface HaluMemTurn {
  role: string;
  content: string;
  timestamp?: string;
  dialogue_turn?: number;
}

export interface HaluMemMemoryPoint {
  index: number;
  memory_content: string;
  memory_type: string;
  memory_source: string;
  is_update: string;
  original_memories?: string[];
  memories_from_system?: string[];
  importance: number;
  timestamp?: string;
}

export interface HaluMemQuestion {
  question: string;
  answer: string;
  evidence?: Array<{ memory_content: string; memory_type?: string }>;
  difficulty?: string;
  question_type?: string;
}

export interface HaluMemSession {
  session_index: number;
  start_time?: string;
  end_time?: string;
  dialogue: HaluMemTurn[];
  memory_points: HaluMemMemoryPoint[];
  questions?: HaluMemQuestion[];
  is_generated_qa_session?: boolean;
  dialogue_token_length?: number;
}

export interface HaluMemUser {
  uuid: string;
  user_name?: string;
  persona_info?: unknown;
  sessions: HaluMemSession[];
}

export function parseHaluMemUser(raw: unknown, sessionOffset = 0): HaluMemUser {
  const o = raw as Record<string, unknown>;
  const uuid = String(o.uuid ?? "unknown");
  const sessionsRaw = Array.isArray(o.sessions) ? o.sessions : [];
  const sessions: HaluMemSession[] = [];
  sessionsRaw.forEach((s, i) => {
    const row = s as Record<string, unknown>;
    const dialogue = Array.isArray(row.dialogue) ? (row.dialogue as HaluMemTurn[]) : [];
    const memory_points = Array.isArray(row.memory_points) ? (row.memory_points as HaluMemMemoryPoint[]) : [];
    const questions = Array.isArray(row.questions) ? (row.questions as HaluMemQuestion[]) : undefined;
    sessions.push({
      session_index: sessionOffset + i,
      start_time: row.start_time != null ? String(row.start_time) : undefined,
      end_time: row.end_time != null ? String(row.end_time) : undefined,
      dialogue,
      memory_points,
      questions,
      is_generated_qa_session: row.is_generated_qa_session === true,
      dialogue_token_length:
        row.dialogue_token_length != null ? Number(row.dialogue_token_length) : undefined,
    });
  });
  return {
    uuid,
    user_name: o.user_name != null ? String(o.user_name) : undefined,
    persona_info: o.persona_info,
    sessions,
  };
}

export function turnsFromHaluMemDialogue(dialogue: HaluMemTurn[]): Turn[] {
  const turns: Turn[] = [];
  for (const d of dialogue) {
    const text = String(d.content ?? "").trim();
    if (!text) continue;
    const role = d.role === "user" ? "user" : "assistant";
    const at = parseHaluMemTimestamp(d.timestamp);
    turns.push(at ? { role, text, at } : { role, text });
  }
  return turns;
}

function parseHaluMemTimestamp(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

export async function loadHaluMemJsonl(path: string, filterUuid?: string): Promise<HaluMemUser[]> {
  if (!existsSync(path)) {
    throw new Error(
      `HaluMem 数据未准备（${path}）。请 --fixture 或 memory eval fetch --adapter halumem --allow-net`,
    );
  }
  const text = await readFile(path, "utf8");
  const users: HaluMemUser[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const user = parseHaluMemUser(JSON.parse(trimmed));
    if (filterUuid && user.uuid !== filterUuid) continue;
    users.push(user);
  }
  if (filterUuid && users.length === 0) {
    throw new Error(`uuid 不在数据中: ${filterUuid}`);
  }
  return users;
}

/** 规则版 integrity：golden 子串出现在本会话 extract 文本中。 */
export function memoryIntegrityHit(extractedBlob: string, goldenContent: string): boolean {
  return goldHit(extractedBlob, goldenContent);
}

export function isTruthyUpdate(v: string | undefined): boolean {
  return v === "True" || v === "true" || v === "TRUE";
}

export function isInterference(mp: HaluMemMemoryPoint): boolean {
  return mp.memory_source === "interference";
}

/** 跳过 generated QA 场；可选 cap 前 N 场（趋势预跑）。 */
export function selectHaluMemSessions(
  sessions: HaluMemSession[],
  maxSessions?: number,
): { sessions: HaluMemSession[]; eligible: number; capped: boolean } {
  const eligible = sessions.filter((s) => !s.is_generated_qa_session);
  if (maxSessions == null) {
    return { sessions: eligible, eligible: eligible.length, capped: false };
  }
  const n = Math.max(1, Math.floor(maxSessions));
  return {
    sessions: eligible.slice(0, n),
    eligible: eligible.length,
    capped: eligible.length > n,
  };
}
