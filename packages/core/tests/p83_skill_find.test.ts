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
  writeSkill,
  listSkills,
  findSkills,
} from "../src/index.ts";

let dir: string;
let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;

const T = { timeout: 60_000 };

async function makeQueue(): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-p83-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
});

describe("P8.3 skill list / find", () => {
  test(
    "P83-01 listSkills 含 trigger / eta_score / support",
    async () => {
      const queue = await makeQueue();
      await writeSkill(repoRoot, pack, queue, {
        brainId: "default",
        name: "meta-skill",
        title: "元数据技能",
        trigger: "支付超时",
        procedure: "固定重试 3 次",
        boundary: "同步支付",
        verification: "单测",
        status: "active",
        etaScore: 0.82,
        support: 4,
      });

      const items = await listSkills(repoRoot, "default");
      const hit = items.find((s) => s.name === "meta-skill");
      expect(hit).toBeDefined();
      expect(hit!.trigger).toBe("支付超时");
      expect(hit!.eta_score).toBe(0.82);
      expect(hit!.support).toBe(4);
    },
    T,
  );

  test(
    "P83-02 findSkills 子串命中 trigger",
    async () => {
      const queue = await makeQueue();
      await writeSkill(repoRoot, pack, queue, {
        brainId: "default",
        name: "pay-retry",
        title: "支付规则",
        trigger: "网关支付重试",
        procedure: "检查幂等后重试",
        boundary: "支付",
        verification: "回归",
        status: "active",
      });

      const hits = await findSkills(repoRoot, "default", "重试");
      expect(hits.some((s) => s.name === "pay-retry")).toBe(true);
    },
    T,
  );

  test(
    "P83-03 findSkills status: active 排除 candidate",
    async () => {
      const queue = await makeQueue();
      await writeSkill(repoRoot, pack, queue, {
        brainId: "default",
        name: "active-skill",
        title: "已激活",
        trigger: "t1",
        procedure: "p1",
        boundary: "b1",
        verification: "v1",
        status: "active",
      });
      await writeSkill(repoRoot, pack, queue, {
        brainId: "default",
        name: "cand-skill",
        title: "候选",
        trigger: "t2",
        procedure: "p2",
        boundary: "b2",
        verification: "v2",
        status: "candidate",
      });

      const hits = await findSkills(repoRoot, "default", "", { status: "active" });
      expect(hits.some((s) => s.name === "active-skill")).toBe(true);
      expect(hits.some((s) => s.name === "cand-skill")).toBe(false);
    },
    T,
  );
});
