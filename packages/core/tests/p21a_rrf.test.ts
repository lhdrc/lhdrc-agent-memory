import { describe, expect, test } from "bun:test";
import {
  armRrfScores,
  fuseHybridArms,
  titlePathBoostNorm,
  RRF_K,
} from "../src/retrieve/rrf.ts";

describe("P2.1a RRF 融合（冻结公式）", () => {
  test("臂内 RRF：rank1 = 1/(k+1)，同 path 取较大 contrib", () => {
    const m = armRrfScores([{ path: "a" }, { path: "b" }, { path: "a" }]);
    expect(m.get("a")).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(m.get("b")).toBeCloseTo(1 / (RRF_K + 2), 10);
  });

  test("titlePathBoostNorm 标题/路径可叠加 cap 1", () => {
    expect(titlePathBoostNorm("网关", "brains/x/sources/a/网关.md", "其他")).toBeCloseTo(0.3);
    expect(titlePathBoostNorm("网关", "other.md", "支付网关超时")).toBeCloseTo(0.7);
    expect(titlePathBoostNorm("网关", "path/网关.md", "网关超时")).toBeCloseTo(1.0);
  });

  test("balanced：同 path 不重复；语义+关键词加权", () => {
    const titles = new Map([["p1", "支付网关超时"], ["p2", "无关"]]);
    const out = fuseHybridArms(
      [{ path: "p1" }, { path: "p2" }],
      [{ path: "p1" }],
      { mode: "balanced", query: "网关", titles, limit: 5, semanticAvailable: true },
    );
    expect(out.map((h) => h.path)).toEqual([...new Set(out.map((h) => h.path))]);
    expect(out[0]!.path).toBe("p1");
    expect(out[0]!.evidence).toContain("keyword");
    expect(out[0]!.evidence).toContain("semantic");
    const expected =
      0.45 * (1 / (RRF_K + 1)) + 0.45 * (1 / (RRF_K + 1)) + 0.1 * 0.7;
    expect(out[0]!.score).toBeCloseTo(expected, 10);
  });

  test("conservative：忽略语义臂", () => {
    const titles = new Map([["p1", "A"], ["p2", "B"]]);
    const out = fuseHybridArms([{ path: "p2" }], [{ path: "p1" }], {
      mode: "conservative",
      query: "zzz",
      titles,
      semanticAvailable: true,
    });
    expect(out.every((h) => !h.evidence.includes("semantic") || h.rrfSemantic === 0)).toBe(true);
    expect(out[0]!.path).toBe("p2");
  });

  test("semantic 不可用时不报错，按 conservative", () => {
    const titles = new Map([["p1", "重试策略"]]);
    const out = fuseHybridArms([{ path: "p1" }], [], {
      mode: "balanced",
      query: "重试",
      titles,
      semanticAvailable: false,
    });
    expect(out.length).toBe(1);
    expect(out[0]!.rrfSemantic).toBe(0);
  });
});
