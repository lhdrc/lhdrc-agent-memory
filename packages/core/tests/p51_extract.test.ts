/**
 * P5.1 L0 extract + cosine dedupe 验收测试。
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
  importNode,
  enrichAfterWrite,
  listMemoryDiffs,
  parseFrontmatter,
  type Fact,
} from "../src/index.ts";

let dir: string;
let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;

const T = { timeout: 120_000 };

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
  dir = await mkdtemp(join(tmpdir(), "dfmem-p51-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
});

describe("P5.1 L0 extract + dedupe", () => {
  test(
    "P51-01: 默认配置 enrichAfterWrite 返回 undefined",
    async () => {
      const path = await capture("默认笔记", "无富化内容。");
      const queue = await makeQueue();
      const enrich = await enrichAfterWrite({
        repoRoot,
        brainId: "default",
        path,
        queue,
      });
      expect(enrich).toBeUndefined();
    },
    T,
  );

  test(
    "P51-02: 余弦去重 — 第二次相似 capture deduped=true 且 memory_diff skip_duplicate",
    async () => {
      await patchMemoryYml({
        embedding: { provider: "local" },
        write: { dedupe_cosine: 0.95, dedupe_window: 200 },
      });

      const body = "支付网关超时后采用固定三次重试策略，间隔 200ms。";
      const queue = await makeQueue();

      const path1 = await capture("重试策略 A", body);
      const enrich1 = await enrichAfterWrite({
        repoRoot,
        brainId: "default",
        path: path1,
        queue,
      });
      expect(enrich1?.deduped).not.toBe(true);

      const path2 = await capture("重试策略 B", body);
      const enrich2 = await enrichAfterWrite({
        repoRoot,
        brainId: "default",
        path: path2,
        queue,
      });
      expect(enrich2?.deduped).toBe(true);

      const diffs = await listMemoryDiffs(repoRoot, "default", 10);
      expect(diffs.some((d) => d.op === "skip_duplicate")).toBe(true);
      expect(existsSync(join(repoRoot, path2))).toBe(true);
    },
    T,
  );

  test(
    "P51-03: 启发式提取 — extract:true body 含列表项写入 facts",
    async () => {
      const body = "## 要点\n\n- 事实A\n\n更多说明。";
      const queue = await makeQueue();
      const path = await capture("提取测试", body);
      const enrich = await enrichAfterWrite({
        repoRoot,
        brainId: "default",
        path,
        queue,
        extract: true,
      });

      expect(enrich?.extracted_facts).toBeGreaterThanOrEqual(1);

      const raw = await readFile(join(repoRoot, path), "utf8");
      const { data } = parseFrontmatter(raw);
      const facts = data.facts as Array<{ text: string }>;
      expect(facts.some((f) => f.text.includes("事实A"))).toBe(true);
    },
    T,
  );

  test(
    "P51-04: 非法 fact 校验失败 E_VALIDATION，文件仍在",
    async () => {
      const queue = await makeQueue();
      const path = await capture("校验测试", "- 正常项");
      const enrich = await enrichAfterWrite({
        repoRoot,
        brainId: "default",
        path,
        queue,
        extract: true,
        extractFactsFn: () =>
          [
            {
              text: "",
              event_type: "note",
              attributed_to: "test",
              at: "2026-01-01",
            },
          ] satisfies Fact[],
      });

      expect(enrich?.error?.code).toBe("E_VALIDATION");
      expect(existsSync(join(repoRoot, path))).toBe(true);
    },
    T,
  );

  test(
    "P51-05: kill_switch.extract 跳过提取 skipped_reason=kill_switch",
    async () => {
      await patchMemoryYml({
        llm: { kill_switch: { extract: true } },
      });

      const queue = await makeQueue();
      const path = await capture("kill switch", "- 事实B");
      const enrich = await enrichAfterWrite({
        repoRoot,
        brainId: "default",
        path,
        queue,
        extract: true,
      });

      expect(enrich?.skipped_reason).toBe("kill_switch");
      expect(enrich?.extracted_facts).toBeUndefined();
    },
    T,
  );

  test(
    "P51-06: import 在 extract:true 时同样写入 facts",
    async () => {
      await patchMemoryYml({
        llm: { extract: true },
      });

      const fixture = join(dir, "import-fixture.md");
      await writeFile(
        fixture,
        `---
title: 导入提取
schema_type: note
source: default
path: sources/default/issues/general/notes/import-extract.md
---

## 摘要

导入

## 正文

- 导入事实X
`,
        "utf8",
      );

      const queue = await makeQueue();
      const path = await importNode(repoRoot, pack, queue, fixture, {
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
      });
      const enrich = await enrichAfterWrite({
        repoRoot,
        brainId: "default",
        path,
        queue,
      });

      expect(enrich?.extracted_facts).toBeGreaterThanOrEqual(1);
      const raw = await readFile(join(repoRoot, path), "utf8");
      const { data } = parseFrontmatter(raw);
      const facts = data.facts as Array<{ text: string }>;
      expect(facts.some((f) => f.text.includes("导入事实X"))).toBe(true);
    },
    T,
  );

  test(
    "P51-07: noDedupe 跳过余弦去重",
    async () => {
      await patchMemoryYml({
        embedding: { provider: "local" },
        write: { dedupe_cosine: 0.95, dedupe_window: 200 },
      });

      const body = "相同正文用于去重对比测试。";
      const queue = await makeQueue();

      const path1 = await capture("去重 A", body);
      await enrichAfterWrite({ repoRoot, brainId: "default", path: path1, queue });

      const path2 = await capture("去重 B", body);
      const enrich2 = await enrichAfterWrite({
        repoRoot,
        brainId: "default",
        path: path2,
        queue,
        noDedupe: true,
      });

      expect(enrich2?.deduped).not.toBe(true);
    },
    T,
  );
});
