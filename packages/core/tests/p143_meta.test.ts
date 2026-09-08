import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  loadPack,
  captureNode,
  loadRepoConfig,
  WriteQueue,
  pgliteIndexHooks,
  readEmbeddingMeta,
} from "../src/index.ts";
import { CHUNKER_VERSION } from "../src/index/chunksplit.ts";

const T = 120000;
let repoRoot: string;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "dfmem-p143m-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
});

describe("P14.3 embedding-meta chunker 版本", () => {
  test(
    "P143-M01 sync 写 embedding-meta 携带 chunker 版本",
    async () => {
      const pack = await loadPack("problem-tree");
      const cfg = await loadRepoConfig(repoRoot);
      const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "meta 版本",
        body: "chunker 版本随 meta 落盘。",
        createdBy: "cli:test",
      });
      const meta = await readEmbeddingMeta(repoRoot);
      expect(meta?.chunker).toBe(CHUNKER_VERSION);
    },
    T,
  );
});
