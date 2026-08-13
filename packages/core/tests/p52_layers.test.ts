/**
 * P5.2 分层读写：abstract / overview / --layer / dirs / auto / query snippet。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  captureNode,
  refreshLayers,
  readNode,
  parseFrontmatter,
  openPglite,
  hybridQueryDetailed,
  DIR_OVERVIEW_NAME,
} from "../src/index.ts";

let dir: string;
let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;

const T = { timeout: 120_000 };
const TAIL = "UNIQUE_TAIL_MARKER_XYZ";
const HEAD = "支付网关超时后采用固定三次重试策略。";

function longBody(): string {
  return `${HEAD}\n\n${"填充段落用于拉开 L0 与全文长度。".repeat(40)}\n\n${TAIL}`;
}

async function makeQueue(): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}

async function patchMemoryYml(patch: Record<string, unknown>): Promise<void> {
  const path = join(repoRoot, "memory.yml");
  const raw = await readFile(path, "utf8");
  const data = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && data[k] && typeof data[k] === "object") {
      data[k] = { ...(data[k] as Record<string, unknown>), ...(v as Record<string, unknown>) };
    } else {
      data[k] = v;
    }
  }
  await writeFile(path, stringifyYaml(data), "utf8");
}

async function capture(title: string, body: string, schemaType = "note") {
  const queue = await makeQueue();
  return captureNode(repoRoot, pack, queue, {
    brainId: "default",
    sourceId: "default",
    schemaType,
    title,
    body,
    createdBy: "cli:test",
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-p52-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
});

describe("P5.2 layers", () => {
  test(
    "P52-01: llm=off refresh 写入非空 abstract 与 overview",
    async () => {
      const path = await capture("分层长文", longBody());
      const queue = await makeQueue();
      const result = await refreshLayers({
        repoRoot,
        brainId: "default",
        queue,
        path,
      });
      expect(result.updated.some((u) => u.path === path && u.abstract && u.overview)).toBe(true);

      const raw = await readFile(join(repoRoot, path), "utf8");
      const { data } = parseFrontmatter(raw);
      expect(String(data.abstract ?? "").trim().length).toBeGreaterThan(0);
      expect(String(data.overview ?? "").trim().length).toBeGreaterThan(0);
    },
    T,
  );

  test(
    "P52-02/03/07: 按层读 L0 < L1 ≤ L2；默认读全文",
    async () => {
      const path = await capture("分层读写", longBody());
      const queue = await makeQueue();
      await refreshLayers({ repoRoot, brainId: "default", queue, path });

      const l0 = await readNode(repoRoot, "default", path, { layer: "l0" });
      const l1 = await readNode(repoRoot, "default", path, { layer: "l1" });
      const l2 = await readNode(repoRoot, "default", path, { layer: "l2" });
      const def = await readNode(repoRoot, "default", path);

      expect(l0.chars).toBeLessThan(l2.chars);
      expect(l0.content).not.toContain(TAIL);
      expect(l1.chars).toBeGreaterThanOrEqual(l0.chars);
      expect(l1.chars).toBeLessThanOrEqual(l2.chars);
      expect(def.layer).toBe("l2");
      expect(def.raw).toContain("## 正文");
      expect(def.content).toBe(def.raw);
    },
    T,
  );

  test(
    "P52-04: 同目录 ≥2 节点 refresh --dirs 写出 _overview.md 含子 title",
    async () => {
      const p1 = await capture("目录节点甲", "甲的正文");
      const p2 = await capture("目录节点乙", "乙的正文");
      const queue = await makeQueue();
      const result = await refreshLayers({
        repoRoot,
        brainId: "default",
        queue,
        dirs: true,
      });
      const overview = result.updated.find((u) => u.path.endsWith(`/${DIR_OVERVIEW_NAME}`));
      expect(overview).toBeDefined();
      const abs = join(repoRoot, overview!.path);
      expect(existsSync(abs)).toBe(true);
      const text = await readFile(abs, "utf8");
      expect(text).toContain("目录节点甲");
      expect(text).toContain("目录节点乙");
      expect(p1).toBeTruthy();
      expect(p2).toBeTruthy();
    },
    T,
  );

  test(
    "P52-05: layers.auto=true capture 即有 abstract；false 则无",
    async () => {
      const offPath = await capture("关闭自动", "无自动摘要正文。");
      const offRaw = await readFile(join(repoRoot, offPath), "utf8");
      expect(parseFrontmatter(offRaw).data.abstract).toBeUndefined();

      await patchMemoryYml({ layers: { auto: true } });
      const onPath = await capture("开启自动", "自动摘要正文应写入 abstract。");
      const onRaw = await readFile(join(repoRoot, onPath), "utf8");
      expect(String(parseFrontmatter(onRaw).data.abstract ?? "").trim().length).toBeGreaterThan(0);
    },
    T,
  );

  test(
    "P52-06: refresh 后 query hit 带 abstract 且 snippet 优先摘要",
    async () => {
      const path = await capture("检索摘要优先", longBody());
      const queue = await makeQueue();
      await refreshLayers({ repoRoot, brainId: "default", queue, path });

      const conn = await openPglite(repoRoot);
      try {
        const { hits } = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "重试",
          repoRoot,
        });
        const hit = hits.find((h) => h.path === path);
        expect(hit).toBeDefined();
        expect(hit!.abstract && hit!.abstract.length > 0).toBe(true);
        expect(hit!.snippet).not.toContain(TAIL);
      } finally {
        await conn.close();
      }
    },
    T,
  );
});
