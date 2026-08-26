/**
 * P11.4 旧事实检索降权（#49：未审默认不自动降权）
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  parseCrossFilePairs,
  type SearchConfig,
} from "../src/index.ts";

const T = { timeout: 120_000 };

function searchOn(on: boolean): SearchConfig {
  return { ...DEFAULT_SEARCH_CONFIG, stale_demote: on, stale_demote_factor: 0.85 };
}

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), "dfmem-p114-"));
  const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  const pack = await loadPack("problem-tree");
  const cfg = await loadRepoConfig(repoRoot);
  const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
  return { repoRoot, pack, queue };
}

async function writeContra(repoRoot: string, a: string, b: string) {
  const abs = join(repoRoot, "brains/default/contradictions.md");
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(
    abs,
    `# Contradictions\n\n## cross-file\n\n- duplicate cosine=0.9600 \`${a}\` facts[0] ↔ \`${b}\` facts[0]\n  - a: "x"\n  - b: "y"\n`,
    "utf8",
  );
}

describe("P11.4 stale demote", () => {
  test("parseCrossFilePairs 只认 cross-file", () => {
    const md = `## intra-file\n- skip \`a.md\` ↔ \`b.md\`\n\n## cross-file\n\n- duplicate cosine=0.9600 \`brains/default/sources/a.md\` facts[0] ↔ \`brains/default/sources/b.md\` facts[1]\n`;
    const pairs = parseCrossFilePairs(md);
    expect(pairs).toEqual([{ a: "brains/default/sources/a.md", b: "brains/default/sources/b.md" }]);
  });

  test(
    "P114-01 较旧侧降权后仍在 hits，较新在前",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      const pathB = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "Alice lives in New York",
        body: "Alice lives in New York.",
        createdBy: "cli:test",
      });
      const pathA = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "Alice lives in San Francisco",
        body: "Alice lives in San Francisco.",
        createdBy: "cli:test",
      });
      await writeContra(repoRoot, pathA, pathB);
      const conn = await openPglite(repoRoot);
      try {
        await conn.db.query(`UPDATE pages SET updated_at = $1 WHERE path = $2`, [
          new Date(Date.now() - 20 * 86_400_000).toISOString(),
          pathB,
        ]);
        await conn.db.query(`UPDATE pages SET updated_at = $1 WHERE path = $2`, [new Date().toISOString(), pathA]);
        const { hits, explain } = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "Alice lives",
          repoRoot,
          skipCache: true,
          explain: true,
          search: searchOn(true),
        });
        const ia = hits.findIndex((h) => h.path === pathA);
        const ib = hits.findIndex((h) => h.path === pathB);
        expect(ia).toBeGreaterThanOrEqual(0);
        expect(ib).toBeGreaterThanOrEqual(0);
        expect(ia).toBeLessThan(ib);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P114-02 stale_demote:false 不改序",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      const pathB = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "Alice lives in New York",
        body: "Alice lives in New York.",
        createdBy: "cli:test",
      });
      const pathA = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "Alice lives in San Francisco",
        body: "Alice lives in San Francisco.",
        createdBy: "cli:test",
      });
      await writeContra(repoRoot, pathA, pathB);
      const conn = await openPglite(repoRoot);
      try {
        await conn.db.query(`UPDATE pages SET updated_at = $1 WHERE path = $2`, [
          new Date(Date.now() - 20 * 86_400_000).toISOString(),
          pathB,
        ]);
        await conn.db.query(`UPDATE pages SET updated_at = $1 WHERE path = $2`, [new Date().toISOString(), pathA]);
        const off = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "Alice lives",
          repoRoot,
          skipCache: true,
          search: searchOn(false),
        });
        const on = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "Alice lives",
          repoRoot,
          skipCache: true,
          search: searchOn(true),
        });
        expect(off.hits.map((h) => h.path)).not.toEqual(on.hits.map((h) => h.path));
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P114-03 无 contradictions.md → explain 空数组",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "无矛盾文件",
        body: "无矛盾文件。",
        createdBy: "cli:test",
      });
      const abs = join(repoRoot, "brains/default/contradictions.md");
      if (existsSync(abs)) await unlink(abs);
      const conn = await openPglite(repoRoot);
      try {
        const { explain } = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "无矛盾",
          repoRoot,
          skipCache: true,
          explain: true,
          search: searchOn(true),
        });
        expect(explain?.stale_demote).toEqual([]);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P114-04 损坏文件 fail-open，序与关降权一致",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "损坏矛盾文件",
        body: "损坏矛盾文件。",
        createdBy: "cli:test",
      });
      await writeFile(join(repoRoot, "brains/default/contradictions.md"), "\x00\x01 not markdown {{{", "utf8");
      const conn = await openPglite(repoRoot);
      try {
        const broken = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "损坏矛盾",
          repoRoot,
          skipCache: true,
          explain: true,
          search: searchOn(true),
        });
        const off = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "损坏矛盾",
          repoRoot,
          skipCache: true,
          search: searchOn(false),
        });
        expect(broken.hits.map((h) => h.path)).toEqual(off.hits.map((h) => h.path));
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P114-05 默认 stale_demote false；init 模板含 false",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      const pathB = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "Alice lives in New York",
        body: "Alice lives in New York.",
        createdBy: "cli:test",
      });
      const pathA = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "Alice lives in San Francisco",
        body: "Alice lives in San Francisco.",
        createdBy: "cli:test",
      });
      await writeContra(repoRoot, pathA, pathB);
      const cfg = await loadRepoConfig(repoRoot);
      expect(cfg.search.stale_demote).toBe(false);
      const conn = await openPglite(repoRoot);
      try {
        const def = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "Alice lives",
          repoRoot,
          skipCache: true,
        });
        const off = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "Alice lives",
          repoRoot,
          skipCache: true,
          search: searchOn(false),
        });
        expect(def.hits.map((h) => h.path)).toEqual(off.hits.map((h) => h.path));
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P114-06 explain factor=0.85",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      const pathB = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "Alice lives in New York",
        body: "Alice lives in New York.",
        createdBy: "cli:test",
      });
      const pathA = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "Alice lives in San Francisco",
        body: "Alice lives in San Francisco.",
        createdBy: "cli:test",
      });
      await writeContra(repoRoot, pathA, pathB);
      const conn = await openPglite(repoRoot);
      try {
        await conn.db.query(`UPDATE pages SET updated_at = $1 WHERE path = $2`, [
          new Date(Date.now() - 20 * 86_400_000).toISOString(),
          pathB,
        ]);
        await conn.db.query(`UPDATE pages SET updated_at = $1 WHERE path = $2`, [new Date().toISOString(), pathA]);
        const { explain } = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "Alice lives",
          repoRoot,
          skipCache: true,
          explain: true,
          search: searchOn(true),
        });
        const row = explain?.stale_demote?.find((s) => s.path === pathB);
        expect(row?.factor).toBe(0.85);
      } finally {
        await conn.close();
      }
    },
    T,
  );
});
