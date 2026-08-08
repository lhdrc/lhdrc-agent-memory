/**
 * 迷你 harness：索引一致性 + 隔离冒烟（P3.3）。
 * 公开基准适配见 adapters/README.md（TODO）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  createBrain,
  loadPack,
  loadRepoConfig,
  WriteQueue,
  pgliteIndexHooks,
  captureNode,
  openPglite,
  hybridQuery,
  syncAll,
  responseContainsSecret,
} from "../packages/core/src/index.ts";

const SECRET_A = "MINI_SECRET_A_x9";
const SECRET_B = "MINI_SECRET_B_y8";

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "dfmem-eval-mini-"));
  try {
    const repoRoot = await initMemoryRepo(dir, { brain: "brain-a", source: "default", force: false });
    await createBrain(repoRoot, "brain-b");
    const pack = await loadPack("problem-tree");
    const cfg = await loadRepoConfig(repoRoot);
    const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);

    await captureNode(repoRoot, pack, queue, {
      brainId: "brain-a",
      sourceId: "default",
      schemaType: "note",
      title: "A",
      body: SECRET_A,
      createdBy: "eval",
    });
    await captureNode(repoRoot, pack, queue, {
      brainId: "brain-b",
      sourceId: "default",
      schemaType: "note",
      title: "B",
      body: SECRET_B,
      createdBy: "eval",
    });

    // 全量增量同步两 brain（避免 rebuild 二次 DROP 抹掉先同步的 brain）
    const conn = await openPglite(repoRoot);
    try {
      await syncAll(conn.db, repoRoot, "brain-a");
      await syncAll(conn.db, repoRoot, "brain-b");
      const a = await hybridQuery(conn.db, { brainId: "brain-a", query: SECRET_A, skipCache: true });
      const leak = await hybridQuery(conn.db, { brainId: "brain-a", query: SECRET_B, skipCache: true });
      if (a.length === 0) throw new Error("索引一致性失败：A 未命中");
      if (responseContainsSecret(leak, SECRET_B)) throw new Error("隔离失败：A 查询泄漏 B");
      console.log(JSON.stringify({ ok: true, hitsA: a.length, leakB: false }));
    } finally {
      await conn.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
