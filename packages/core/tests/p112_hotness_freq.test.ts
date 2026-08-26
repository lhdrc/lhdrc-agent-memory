/**
 * P11.2 hotness = freq × recency
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  captureNode,
  openPglite,
  hybridQueryDetailed,
  DEFAULT_SEARCH_CONFIG,
  HIT_COUNTS_REL,
  freqFromHitCount,
  type SearchConfig,
} from "../src/index.ts";

const T = { timeout: 120_000 };

function hotSearch(freq = true): SearchConfig {
  return {
    ...DEFAULT_SEARCH_CONFIG,
    hotness: { enabled: true, half_life_days: 30, alpha: 0.15, freq },
  };
}

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), "dfmem-p112-"));
  const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  const pack = await loadPack("problem-tree");
  const cfg = await loadRepoConfig(repoRoot);
  const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
  return { repoRoot, pack, queue };
}

async function writeCounts(repoRoot: string, counts: Record<string, number>) {
  const abs = join(repoRoot, HIT_COUNTS_REL);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify({ v: 1, counts }), "utf8");
}

describe("P11.2 hotness freq", () => {
  test("freqFromHitCount: n=0 → 1；n>0 单调递增且 <1", () => {
    expect(freqFromHitCount(0)).toBe(1);
    expect(freqFromHitCount(1)).toBeLessThan(1);
    expect(freqFromHitCount(8)).toBeGreaterThan(freqFromHitCount(1));
  });

  test(
    "P112-01 空计数两篇仅 mtime 不同 → 序与 freq 关闭相同",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      const older = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "固定重试甲",
        body: "固定重试策略甲。",
        createdBy: "cli:test",
      });
      const newer = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "固定重试乙",
        body: "固定重试策略乙。",
        createdBy: "cli:test",
      });
      const conn = await openPglite(repoRoot);
      try {
        await conn.db.query(`UPDATE pages SET updated_at = $1 WHERE path = $2`, [
          new Date(Date.now() - 40 * 86_400_000).toISOString(),
          older,
        ]);
        await conn.db.query(`UPDATE pages SET updated_at = $1 WHERE path = $2`, [
          new Date().toISOString(),
          newer,
        ]);
        const withFreq = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "固定重试",
          repoRoot,
          skipCache: true,
          search: hotSearch(true),
        });
        const noFreq = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "固定重试",
          repoRoot,
          skipCache: true,
          search: hotSearch(false),
        });
        expect(withFreq.hits.map((h) => h.path)).toEqual(noFreq.hits.map((h) => h.path));
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P112-02 n=8 高于 n=1（同 recency、标题相当）",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      const pathA = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "固定重试甲",
        body: "固定重试策略。",
        createdBy: "cli:test",
      });
      const pathB = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "固定重试乙",
        body: "固定重试策略。",
        createdBy: "cli:test",
      });
      const now = new Date().toISOString();
      const conn = await openPglite(repoRoot);
      try {
        await conn.db.query(`UPDATE pages SET updated_at = $1 WHERE path IN ($2, $3)`, [now, pathA, pathB]);
        await writeCounts(repoRoot, { [pathA]: 8, [pathB]: 1 });
        const { hits } = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "固定重试",
          repoRoot,
          skipCache: true,
          search: hotSearch(true),
        });
        const a = hits.find((h) => h.path === pathA);
        const b = hits.find((h) => h.path === pathB);
        expect(a && b).toBeTruthy();
        expect(a!.score).toBeGreaterThan(b!.score);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P112-03 第一次 identity，第二次 applied",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "热度计数笔记",
        body: "热度计数笔记正文。",
        createdBy: "cli:test",
      });
      const conn = await openPglite(repoRoot);
      try {
        const first = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "热度计数",
          repoRoot,
          skipCache: true,
          explain: true,
          search: hotSearch(true),
        });
        expect(first.explain?.hotness_detail?.freq).toBe("identity");
        const second = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "热度计数",
          repoRoot,
          skipCache: true,
          explain: true,
          search: hotSearch(true),
        });
        expect(second.explain?.hotness_detail?.freq).toBe("applied");
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P112-04 旧文档标题全命中仍压过无关新文档（即使新文档 n=5）",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      const oldPath = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "decision",
        title: "重试策略",
        body: "网关超时改为固定重试 3 次。",
        createdBy: "cli:test",
      });
      const newPath = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "今日天气",
        body: "晴。顺带一提重试这个词出现过。",
        createdBy: "cli:test",
      });
      const conn = await openPglite(repoRoot);
      try {
        await conn.db.query(`UPDATE pages SET updated_at = $1 WHERE path = $2`, [
          new Date(Date.now() - 400 * 86_400_000).toISOString(),
          oldPath,
        ]);
        await conn.db.query(`UPDATE pages SET updated_at = $1 WHERE path = $2`, [new Date().toISOString(), newPath]);
        await writeCounts(repoRoot, { [newPath]: 5 });
        const { hits } = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "重试策略",
          repoRoot,
          skipCache: true,
          search: hotSearch(true),
        });
        const oldHit = hits.find((h) => h.path === oldPath);
        const newHit = hits.find((h) => h.path === newPath);
        expect(oldHit).toBeDefined();
        if (newHit && oldHit) {
          expect(oldHit.score).toBeGreaterThan(newHit.score);
        }
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P112-05 counter 路径不可写 → query 仍成功",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "写入失败热度",
        body: "counter 目录挡路。",
        createdBy: "cli:test",
      });
      await mkdir(join(repoRoot, HIT_COUNTS_REL), { recursive: true });
      const conn = await openPglite(repoRoot);
      try {
        const { hits } = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "写入失败热度",
          repoRoot,
          skipCache: true,
          explain: true,
          search: hotSearch(true),
        });
        expect(hits.length).toBeGreaterThan(0);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P112-06 freq:false 有计数也不改序（相对 identity）",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      const pathA = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "固定重试甲",
        body: "固定重试策略。",
        createdBy: "cli:test",
      });
      const pathB = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "固定重试乙",
        body: "固定重试策略。",
        createdBy: "cli:test",
      });
      const now = new Date().toISOString();
      const conn = await openPglite(repoRoot);
      try {
        await conn.db.query(`UPDATE pages SET updated_at = $1 WHERE path IN ($2, $3)`, [now, pathA, pathB]);
        await writeCounts(repoRoot, { [pathA]: 8, [pathB]: 1 });
        const off = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "固定重试",
          repoRoot,
          skipCache: true,
          search: hotSearch(false),
        });
        const yml = await readFileYmlHasFreq(repoRoot);
        expect(yml).toBe(true);
        const aOff = off.hits.find((h) => h.path === pathA);
        const bOff = off.hits.find((h) => h.path === pathB);
        expect(aOff && bOff).toBeTruthy();
        const on = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "固定重试",
          repoRoot,
          skipCache: true,
          search: hotSearch(true),
        });
        const aOn = on.hits.find((h) => h.path === pathA)!;
        const bOn = on.hits.find((h) => h.path === pathB)!;
        expect(aOn.score).toBeGreaterThan(bOn.score);
        expect(Math.abs(aOff!.score - bOff!.score)).toBeLessThan(Math.abs(aOn.score - bOn.score) + 1e-9);
      } finally {
        await conn.close();
      }
    },
    T,
  );
});

async function readFileYmlHasFreq(repoRoot: string): Promise<boolean> {
  const { readFile } = await import("node:fs/promises");
  const yml = await readFile(join(repoRoot, "memory.yml"), "utf8");
  return yml.includes("freq: true");
}
