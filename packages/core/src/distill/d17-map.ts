/**
 * D17：OpenViking 两级判定 → 经验层动作（禁止删 sources/）。
 * specs/二期/P2.2-distill-layers.md · 08 D17
 */
import type { DistillDecision } from "../llm/types.ts";

export type DistillMappedOp =
  | { op: "noop" }
  | { op: "experience_create" }
  | { op: "experience_merge"; targetExpId: string }
  | { op: "experience_supersede"; targetExpId: string };

/**
 * 映射表（单测钉死）：
 * - item:delete → 旧经验 superseded（非删源）
 * - item:merge + target → merge 经验
 * - candidate:create → 新建经验
 * - skip/none → noop
 */
export function mapDistillDecision(d: DistillDecision): DistillMappedOp {
  if (d.item === "delete") {
    if (!d.targetExpId) return { op: "noop" };
    return { op: "experience_supersede", targetExpId: d.targetExpId };
  }
  if (d.item === "merge") {
    if (!d.targetExpId) return { op: "noop" };
    return { op: "experience_merge", targetExpId: d.targetExpId };
  }
  if (d.candidate === "create") {
    return { op: "experience_create" };
  }
  return { op: "noop" };
}

/** 启发式 L0 abstract：正文前 100 字 */
export function heuristicAbstract(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 100);
}
