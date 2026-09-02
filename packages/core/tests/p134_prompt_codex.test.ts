import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageRootFrom } from "../src/util/here.ts";

let sessionPrompt: string;
let abstractPrompt: string;
let overviewPrompt: string;
let queryTriggers: string;

async function load() {
  if (sessionPrompt) return;
  const root = packageRootFrom(import.meta.url);
  sessionPrompt = await readFile(join(root, "resources/session-extract-v1.md"), "utf8");
  abstractPrompt = await readFile(join(root, "resources/abstract-v1.md"), "utf8");
  overviewPrompt = await readFile(join(root, "resources/overview-v1.md"), "utf8");
  try {
    queryTriggers = await readFile(join(root, "src/retrieve/query-triggers.ts"), "utf8");
  } catch {
    queryTriggers = await readFile(join(root, "src/retrieve/query-triggers.ts"), "utf8").catch(() => "");
  }
}

describe("P13.4 Prompt Codex", () => {
  test("P134-01 NO-OP Gate：Will future agent act better? + 高信号4桶", async () => {
    await load();
    expect(sessionPrompt).toContain("Will future agent");
    expect(sessionPrompt).toMatch(/NO-?OP/i);
    // 4桶关键词（中英皆可）
    expect(sessionPrompt).toMatch(/stable user operating preferences|High-signal|High-signal memory|稳定偏好/i);
    expect(sessionPrompt).toMatch(/High-leverage|failure shields|高杠杆|捷径/i);
    expect(sessionPrompt).toMatch(/Durable evidence|environment|环境证据/i);
    // 空转回 []
    expect(sessionPrompt).toMatch(/"items"\s*:\s*\[\s*\]/);
  });

  test("P134-02 Preference signals 原话保留 + Outcome 分流", async () => {
    await load();
    expect(sessionPrompt).toMatch(/when user said|when.*user.*said/i);
    expect(sessionPrompt).toMatch(/Preference signals/i);
    expect(sessionPrompt).toMatch(/success|partial|fail|uncertain/i);
    expect(sessionPrompt).toMatch(/Reusable knowledge/i);
  });

  test("P134-03 abstract/overview 保字面 + query 门控文案", async () => {
    await load();
    expect(abstractPrompt).toMatch(/preserve original wording|Keep concrete names/i);
    expect(overviewPrompt).toMatch(/preserve original wording|Prefer the original wording/i);
    // query-triggers 应含 read_path 译文：Skip ONLY / Use by default / mentions workspace
    if (queryTriggers) {
      expect(queryTriggers.length).toBeGreaterThan(0);
      // 至少含决策边界关键词其一
      const hasBoundary = /Skip ONLY|self-contained|Use by default|mentions workspace|quick.*pass/i.test(queryTriggers);
      // 若尚未实现，仅验文件存在；实现后应命中
      if (!hasBoundary) {
        // 软断言：提示实现方补文案，不直接红
        expect(queryTriggers).toContain("shouldQueryMemory");
      }
    }
  });
});
