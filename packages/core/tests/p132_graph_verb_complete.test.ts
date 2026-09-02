import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  captureNode,
  openPglite,
  parseRelationalQuery,
  graphArmDetailed,
  hybridQueryDetailed,
} from "../src/index.ts";

let dir: string;
let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;

const T = { timeout: 30_000 };

async function makeQueue(): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}

async function capture(title: string, body: string) {
  const queue = await makeQueue();
  return captureNode(repoRoot, pack, queue, {
    brainId: "default",
    sourceId: "default",
    schemaType: "decision",
    title,
    body,
    createdBy: "cli:test",
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-p132-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
});

describe("P13.2 10种边建≡检索", () => {
  test(
    "P132-01 decided/produced_by/belongs_to/invested_in/advises 各 1 例 relational",
    async () => {
      // decided: 决定 Acme
      await capture("Decided Acme", "我们决定 Acme 方案由 @alice 决定 [[acme]]");
      // produced_by: 产出
      await capture("Produced Acme doc", "Alice 产出 acme 文档 [[acme]] 产出");
      // belongs_to: 属于
      await capture("Acme belongs", "Acme 属于 @payment [[payment]]");
      // invested_in: 投资
      await capture("Invest Acme", "我们投资 Acme 项目 @acme 投资");
      // advises: 顾问
      await capture("Advise Acme", "Alice 顾问 Acme @acme 顾问");

      const conn = await openPglite(repoRoot);
      try {
        const cases: Array<{ q: string; verb: string }> = [
          { q: "谁决定了 acme", verb: "decided" },
          { q: "who decided acme", verb: "decided" },
          { q: "谁产出了 acme", verb: "produced_by" },
          { q: "who produced acme", verb: "produced_by" },
          { q: "acme属于 payment", verb: "belongs_to" },
          { q: "acme belongs to payment", verb: "belongs_to" },
          { q: "谁投资了 acme", verb: "invested_in" },
          { q: "who invested in acme", verb: "invested_in" },
          { q: "谁是 acme顾问", verb: "advises" },
          { q: "who advises acme", verb: "advises" },
        ];
        for (const c of cases) {
          const parsed = parseRelationalQuery(c.q);
          expect(parsed, `parse ${c.q}`).not.toBeNull();
          expect(parsed!.verb).toBe(c.verb);
          const arm = await graphArmDetailed(conn.db, { brainId: "default", query: c.q });
          // relational 优先，若建边成功则 hits 非空；至少 mode 为 relational（解析成功即 relational）
          expect(arm.mode).toBe("relational");
          // 若 hits 为空说明建边未命中，视为 fail
          expect(arm.hits.length, `graph hits for ${c.q}`).toBeGreaterThan(0);
        }
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test("P132-02 10 种 verb 均可 parseRelationalQuery", () => {
    const all = [
      ["谁提到了 acme", "mentions"],
      ["谁负责支付", "works_on"],
      ["payment references", "references"],
      ["who works at Rivermark", "works_at"],
      ["who founded Acme", "founded"],
      ["谁决定了 acme", "decided"],
      ["谁产出了 acme", "produced_by"],
      ["acme属于 payment", "belongs_to"],
      ["谁投资了 acme", "invested_in"],
      ["who advises acme", "advises"],
    ] as const;
    for (const [q, verb] of all) {
      const p = parseRelationalQuery(q);
      expect(p, q).not.toBeNull();
      expect(p!.verb).toBe(verb);
    }
  });

  test(
    "P132-03 hybrid 图臂不回退：relational query 走 graph arm",
    async () => {
      await capture("支付负责人", "Alice 负责 @支付 模块对接与验收。");
      const conn = await openPglite(repoRoot);
      try {
        const { explain } = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "谁负责支付",
          repoRoot,
          explain: true,
          skipCache: true,
        });
        expect(explain!.arms.graph.length).toBeGreaterThan(0);
      } finally {
        await conn.close();
      }
    },
    T,
  );
});
