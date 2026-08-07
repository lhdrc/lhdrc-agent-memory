import { describe, expect, test } from "bun:test";
import { mapDistillDecision, heuristicAbstract } from "../src/distill/d17-map.ts";

describe("P2.2 D17 蒸馏判定映射", () => {
  test("item:delete → experience_supersede（不删源）", () => {
    expect(
      mapDistillDecision({
        candidate: "none",
        item: "delete",
        targetExpId: "exp1",
        confidence: 0.9,
        rationale: "stale",
      }),
    ).toEqual({ op: "experience_supersede", targetExpId: "exp1" });
  });

  test("item:merge → experience_merge", () => {
    expect(
      mapDistillDecision({
        candidate: "none",
        item: "merge",
        targetExpId: "exp2",
        confidence: 0.8,
        rationale: "dup",
      }),
    ).toEqual({ op: "experience_merge", targetExpId: "exp2" });
  });

  test("candidate:create → experience_create", () => {
    expect(
      mapDistillDecision({ candidate: "create", confidence: 0.7, rationale: "new" }),
    ).toEqual({ op: "experience_create" });
  });

  test("skip/none → noop", () => {
    expect(mapDistillDecision({ candidate: "skip", confidence: 0.1, rationale: "x" })).toEqual({
      op: "noop",
    });
    expect(mapDistillDecision({ candidate: "none", confidence: 0.1, rationale: "x" })).toEqual({
      op: "noop",
    });
  });

  test("delete/merge 缺 target → noop", () => {
    expect(
      mapDistillDecision({ candidate: "none", item: "delete", confidence: 1, rationale: "x" }),
    ).toEqual({ op: "noop" });
  });

  test("heuristicAbstract 截断 100 字", () => {
    const s = "网关".repeat(80);
    expect(heuristicAbstract(s).length).toBe(100);
  });
});
