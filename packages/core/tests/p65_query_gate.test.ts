/**
 * P6.5 查询门控（不启 hook）
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { shouldQueryMemory } from "../src/index.ts";

describe("P6.5 shouldQueryMemory", () => {
  test("P65-01: 「以前怎么做」→ 非 null，command=find 或 think", () => {
    const r = shouldQueryMemory({ userText: "以前怎么做" });
    expect(r).not.toBeNull();
    expect(r!.command === "find" || r!.command === "think").toBe(true);
  });

  test("P65-02: 「再试一次」→ null", () => {
    expect(shouldQueryMemory({ userText: "再试一次" })).toBeNull();
  });

  test("P65-03: 「实现 ErrorCodes 新码」→ 非 null，command=think", () => {
    const r = shouldQueryMemory({ userText: "实现 ErrorCodes 新码" });
    expect(r).not.toBeNull();
    expect(r!.command).toBe("think");
  });

  test("P65-04: 「hi」→ null", () => {
    expect(shouldQueryMemory({ userText: "hi" })).toBeNull();
  });

  test("P65-05: 同一句 120s 内第二次 → null", () => {
    const now = 1_700_000_000_000;
    const first = shouldQueryMemory({ userText: "以前怎么做", ctx: { nowMs: now } });
    expect(first).not.toBeNull();
    const second = shouldQueryMemory({
      userText: "以前怎么做",
      ctx: { nowMs: now + 10_000, lastQuery: "以前怎么做", lastQueryAtMs: now },
    });
    expect(second).toBeNull();
  });

  test("P65-06: 含 <df-memory-context → null", () => {
    expect(
      shouldQueryMemory({
        userText: `<df-memory-context query="x">以前怎么做</df-memory-context> 继续`,
      }),
    ).toBeNull();
  });

  test("P65-07: sessionStart + 「随便写点」→ 非 null", () => {
    const r = shouldQueryMemory({ userText: "随便写点", ctx: { sessionStart: true } });
    expect(r).not.toBeNull();
    expect(r!.command).toBe("think");
  });

  test("P65-08: agent-protocol-v1.md 含何时查、交原文、禁自造格式、剥离标签", async () => {
    const p = join(import.meta.dir, "../resources/agent-protocol-v1.md");
    const text = await readFile(p, "utf8");
    expect(text).toContain("何时查");
    expect(text).toContain("交原文");
    expect(text).toContain("禁自造格式");
    expect(text).toContain("剥离");
    expect(text).toContain("df-memory-context");
  });
});
