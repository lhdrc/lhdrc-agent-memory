/**
 * P7.1：complete() 文本 → 各 purpose JSON 合同。
 */
import { MemoryError, ErrorCodes } from "../errors.ts";
import type { DistillDecision, ExperienceResult } from "./types.ts";

export function stripCompleteJson(text: string): string {
  let s = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```/im.exec(s);
  if (fence?.[1]) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new MemoryError(ErrorCodes.LLM, "complete 响应不是 JSON 对象");
  }
  return s.slice(start, end + 1);
}

export function parseCompleteObject(text: string): Record<string, unknown> {
  const s = stripCompleteJson(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch (e) {
    throw new MemoryError(ErrorCodes.LLM, `complete JSON.parse 失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MemoryError(ErrorCodes.LLM, "complete 响应不是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

const CANDIDATES = new Set(["skip", "create", "none"]);
const ITEMS = new Set(["merge", "delete"]);

export function parseJudgeDecision(text: string): DistillDecision {
  let obj: Record<string, unknown>;
  try {
    obj = parseCompleteObject(text);
  } catch {
    return { candidate: "skip", confidence: 0, rationale: "parse_error" };
  }
  const raw = String(obj.candidate ?? "").trim();
  if (!CANDIDATES.has(raw)) {
    return { candidate: "skip", confidence: 0, rationale: "parse_error" };
  }
  const itemRaw = obj.item == null || obj.item === "" ? null : String(obj.item);
  const item = itemRaw && ITEMS.has(itemRaw) ? (itemRaw as "merge" | "delete") : undefined;
  const target =
    obj.targetExpId == null || obj.targetExpId === "" ? undefined : String(obj.targetExpId);
  const confidence = Number(obj.confidence);
  return {
    candidate: raw as DistillDecision["candidate"],
    item,
    targetExpId: target,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    rationale: String(obj.rationale ?? ""),
  };
}

export function parseExperienceResult(text: string): ExperienceResult {
  const obj = parseCompleteObject(text);
  const title = String(obj.title ?? "").trim();
  if (!title) {
    throw new MemoryError(ErrorCodes.LLM, "refineExperience 响应缺少 title");
  }
  return {
    title,
    trigger: String(obj.trigger ?? "").trim(),
    procedure: String(obj.procedure ?? "").trim(),
    boundary: String(obj.boundary ?? "").trim(),
    body: String(obj.body ?? "").trim(),
  };
}

/** 无法抽出 JSON 对象时 true（应再 complete 一次）；非法 candidate 不算 JSON 失败。 */
export function isJudgeJsonFailure(text: string): boolean {
  try {
    parseCompleteObject(text);
    return false;
  } catch {
    return true;
  }
}
