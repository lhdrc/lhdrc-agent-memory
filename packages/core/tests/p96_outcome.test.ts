import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  writeSkill,
  applySkillOutcome,
  listBootExperiences,
  writeExperience,
} from "../src/index.ts";

let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;

const T = { timeout: 60_000 };

async function makeQueue(): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "dfmem-p96-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
});

describe("P9.6 outcome + boot experiences", () => {
  test(
    "P96-01: outcome success → support+1, eta up, status still candidate",
    async () => {
      const queue = await makeQueue();
      await writeSkill(repoRoot, pack, queue, {
        brainId: "default",
        name: "outcome-skill",
        title: "打分技能",
        trigger: "t",
        procedure: "p",
        boundary: "b",
        verification: "v",
        status: "candidate",
        etaScore: 0.5,
        support: 1,
      });
      const r = await applySkillOutcome(repoRoot, "default", "outcome-skill", queue, { success: true });
      expect(r.support).toBe(2);
      expect(r.eta_score).toBeCloseTo(0.6, 5);
      expect(r.status).toBe("candidate");
      const raw = await readFile(join(repoRoot, r.path), "utf8");
      expect(raw).toContain("status: candidate");
    },
    T,
  );

  test(
    "listBootExperiences: active only, sorted by eta then support",
    async () => {
      const queue = await makeQueue();
      const src = "sources/default/x.md";
      await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "低分",
        trigger: "a",
        procedure: "p",
        boundary: "b",
        sourcePaths: [src],
        status: "active",
        etaScore: 0.3,
        support: 5,
        id: "exp-low",
      });
      await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "高分",
        trigger: "b",
        procedure: "p",
        boundary: "b",
        sourcePaths: [src],
        status: "active",
        etaScore: 0.9,
        support: 1,
        id: "exp-high",
      });
      await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "归档",
        trigger: "c",
        procedure: "p",
        boundary: "b",
        sourcePaths: [src],
        status: "archived",
        etaScore: 0.99,
        support: 99,
        id: "exp-arch",
      });
      const items = await listBootExperiences(repoRoot, "default", 3);
      expect(items.length).toBe(2);
      expect(items[0]!.title).toBe("高分");
      expect(items[1]!.title).toBe("低分");
      expect(items.every((i) => i.path.includes("/experiences/"))).toBe(true);
    },
    T,
  );
});
