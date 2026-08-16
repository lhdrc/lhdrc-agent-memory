/**
 * P9.4 source ID 7-layer resolution.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  loadBrainConfig,
  resolveSourceIdFull,
  sourceMarker,
} from "../src/index.ts";

const T = { timeout: 120_000 };

let dir: string;
let repoRoot: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-p94-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
});

async function writeBrainSources(sourcesYaml: string): Promise<void> {
  const brainPath = join(repoRoot, "brains", "default", "brain.yml");
  const raw = await readFile(brainPath, "utf8");
  const withoutSources = raw.replace(/\nsources:[\s\S]*?(?=\ncreated_at:)/, "");
  const next = withoutSources.replace(
    /^created_at:/m,
    `sources:\n${sourcesYaml}\ncreated_at:`,
  );
  await writeFile(brainPath, next);
}

describe("P9.4 source resolve", () => {
  test("P94-01 仅 brain default=a → 解析 a", async () => {
    await writeBrainSources("  default: a");
    const brain = await loadBrainConfig(repoRoot, "default");
    const id = await resolveSourceIdFull({
      repoRoot,
      brainId: "default",
      cwd: dir,
      brain,
    });
    expect(id).toBe("a");
  }, T);

  test("P94-02 env 与 default 不同 → env 赢", async () => {
    await writeBrainSources("  default: a");
    const brain = await loadBrainConfig(repoRoot, "default");
    const prev = process.env.DF_MEMORY_SOURCE;
    try {
      process.env.DF_MEMORY_SOURCE = "env-src";
      const id = await resolveSourceIdFull({
        repoRoot,
        brainId: "default",
        cwd: dir,
        brain,
      });
      expect(id).toBe("env-src");
    } finally {
      if (prev === undefined) delete process.env.DF_MEMORY_SOURCE;
      else process.env.DF_MEMORY_SOURCE = prev;
    }
  }, T);

  test("P94-03 flag b 赢过 env", async () => {
    await writeBrainSources("  default: a");
    const brain = await loadBrainConfig(repoRoot, "default");
    const prev = process.env.DF_MEMORY_SOURCE;
    try {
      process.env.DF_MEMORY_SOURCE = "env-src";
      const id = await resolveSourceIdFull({
        repoRoot,
        brainId: "default",
        flag: "b",
        cwd: dir,
        brain,
      });
      expect(id).toBe("b");
    } finally {
      if (prev === undefined) delete process.env.DF_MEMORY_SOURCE;
      else process.env.DF_MEMORY_SOURCE = prev;
    }
  }, T);

  test("P94-04 cwd 在 sources/team 且点文件 team → team", async () => {
    const teamDir = join(repoRoot, "brains", "default", "sources", "team");
    await mkdir(teamDir, { recursive: true });
    await writeFile(join(teamDir, ".dfmemory-source"), sourceMarker("team", "default"));
    const id = await resolveSourceIdFull({
      repoRoot,
      brainId: "default",
      cwd: teamDir,
    });
    expect(id).toBe("team");
  }, T);

  test("P94-05 点文件存在且被读取（id 等于文件内 slug）", async () => {
    const nested = join(repoRoot, "scratch", "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, ".dfmemory-source"), sourceMarker("marker-src", "default"));
    const id = await resolveSourceIdFull({
      repoRoot,
      brainId: "default",
      cwd: nested,
    });
    expect(id).toBe("marker-src");
  }, T);

  test("P94-06 sources 仅 default+billing → sole → billing", async () => {
    await writeBrainSources("  default: default\n  billing: billing");
    const brain = await loadBrainConfig(repoRoot, "default");
    const id = await resolveSourceIdFull({
      repoRoot,
      brainId: "default",
      cwd: dir,
      brain,
    });
    expect(id).toBe("billing");
  }, T);

  test("P94-07 三个非 default source → 不走 sole，落到 default", async () => {
    await writeBrainSources(
      "  default: default\n  billing: billing\n  team: team\n  app: app",
    );
    const brain = await loadBrainConfig(repoRoot, "default");
    const id = await resolveSourceIdFull({
      repoRoot,
      brainId: "default",
      cwd: dir,
      brain,
    });
    expect(id).toBe("default");
  }, T);

  test("P94-08 非法 slug 点文件 → 跳过该层", async () => {
    const badDir = join(repoRoot, "brains", "default", "sources", "team");
    await mkdir(badDir, { recursive: true });
    await writeFile(
      join(badDir, ".dfmemory-source"),
      "source_id: NOT VALID!\nbrain_id: default\n",
    );
    await writeBrainSources("  default: fallback-src");
    const brain = await loadBrainConfig(repoRoot, "default");
    const id = await resolveSourceIdFull({
      repoRoot,
      brainId: "default",
      cwd: badDir,
      brain,
    });
    expect(id).toBe("team");
  }, T);

  test("P94-09 无任何命中 → default", async () => {
    const id = await resolveSourceIdFull({
      repoRoot,
      brainId: "default",
      cwd: dir,
    });
    expect(id).toBe("default");
  }, T);
});
