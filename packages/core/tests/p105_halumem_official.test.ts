/**
 * P10.5 HaluMem official prompt parsers + hash stability.
 */
import { describe, expect, test } from "bun:test";
import {
  halumemOfficialPromptHash,
  formatOfficialQaJudgePrompt,
  HALUMEM_OFFICIAL_QA_TOP_K,
} from "../../../evals/adapters/halumem-prompts.ts";
import {
  parseIntegrityScore,
  parseQaVerdict,
  parseUpdateVerdict,
  qaKeyPoints,
} from "../../../evals/adapters/halumem-official-eval.ts";

describe("P10.5 halumem official", () => {
  test("P105-01: prompt hash stable + parsers", () => {
    const h = halumemOfficialPromptHash();
    expect(h.answer).toHaveLength(64);
    expect(h.qa).toHaveLength(64);
    expect(parseIntegrityScore('{"score":"2","reasoning":"ok"}')).toBe(2);
    expect(parseIntegrityScore('{"score":"1"}')).toBe(1);
    expect(parseIntegrityScore("bad")).toBe(0);
    expect(parseQaVerdict('{"evaluation_result":"Correct"}')).toBe("Correct");
    expect(parseQaVerdict('{"evaluation_result":"Hallucination"}')).toBe("Hallucination");
    expect(parseQaVerdict('{"evaluation_result":"Omission"}')).toBe("Omission");
    expect(parseUpdateVerdict('{"evaluation_result":"Correct"}')).toBe("Correct");
    expect(HALUMEM_OFFICIAL_QA_TOP_K).toBe(20);
  });

  test("P105-02: QA judge prompt includes evidence key points", () => {
    const p = formatOfficialQaJudgePrompt(
      "Q?",
      "gold",
      qaKeyPoints({
        question: "Q?",
        answer: "gold",
        evidence: [{ memory_content: "ev1" }, { memory_content: "ev2" }],
      }),
      "pred",
    );
    expect(p.prompt).toContain("ev1");
    expect(p.prompt).toContain("ev2");
    expect(p.prompt).toContain("Reference Answer");
  });
});
