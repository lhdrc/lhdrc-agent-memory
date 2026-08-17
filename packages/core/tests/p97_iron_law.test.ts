/**
 * P9.7 Iron Law：back-link + facts `[Source:]` 后缀。
 */
import { beforeEach, describe, expect, test, spyOn } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import * as nodeFs from "node:fs/promises";
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
  createEntityRegistry,
  applyIronLaw,
  directGitExecutor,
  openPglite,
  bm25Query,
  parseFrontmatter,
} from "../src/index.ts";

const T = { timeout: 120_000 };

let dir: string;
let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;
let queue: WriteQueue;

async function makeQueue(): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}

async function patchMemoryYml(repoRoot: string, patch: Record<string, unknown>): Promise<void> {
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

function captureOpts(overrides: Record<string, unknown> = {}) {
  return {
    brainId: "default",
    sourceId: "default",
    schemaType: "decision",
    title: "重试策略",
    body: "网关超时改为固定重试 3 次。",
    createdBy: "cli:test",
    ...overrides,
  };
}

async function query(q: string) {
  const conn = await openPglite(repoRoot);
  try {
    return await bm25Query(conn.db, { brainId: "default", query: q, limit: 10 });
  } finally {
    await conn.close();
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-p97-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
  queue = await makeQueue();
});

describe("P9.7 Iron Law", () => {
  test(
    "P97-01: node links alice → alice.md links contain node path",
    async () => {
      const reg = createEntityRegistry(repoRoot, "default", queue);
      await reg.create({ slug: "alice", title: "Alice", createdBy: "cli:test" });

      const rel = await captureNode(
        repoRoot,
        pack,
        queue,
        captureOpts({
          links: [{ to: "brains/default/entities/alice.md", type: "mentions", source: "frontmatter" }],
        }),
      );

      const aliceRaw = await readFile(join(repoRoot, "brains/default/entities/alice.md"), "utf8");
      const { data } = parseFrontmatter(aliceRaw);
      const links = data.links as Array<{ to: string; type: string }>;
      expect(links.some((l) => l.to === rel && l.type === "mentioned_in")).toBe(true);
    },
    T,
  );

  test(
    "P97-02: applyIronLaw twice on same node → no duplicate backlink",
    async () => {
      const reg = createEntityRegistry(repoRoot, "default", queue);
      await reg.create({ slug: "alice", title: "Alice", createdBy: "cli:test" });

      const rel = await captureNode(
        repoRoot,
        pack,
        queue,
        captureOpts({
          links: [{ to: "alice", type: "mentions", source: "frontmatter" }],
        }),
      );

      const exec = directGitExecutor(repoRoot);
      await applyIronLaw(repoRoot, rel, exec, { brainId: "default" });

      const aliceRaw = await readFile(join(repoRoot, "brains/default/entities/alice.md"), "utf8");
      const { data } = parseFrontmatter(aliceRaw);
      const links = (data.links as Array<{ to: string; type: string }>) ?? [];
      const mentioned = links.filter((l) => l.to === rel && l.type === "mentioned_in");
      expect(mentioned.length).toBe(1);
    },
    T,
  );

  test(
    "P97-03: no entity page → main node still written",
    async () => {
      const rel = await captureNode(
        repoRoot,
        pack,
        queue,
        captureOpts({
          links: [{ to: "ghost", type: "mentions", source: "frontmatter" }],
        }),
      );
      expect(existsSync(join(repoRoot, rel))).toBe(true);
      expect(existsSync(join(repoRoot, "brains/default/entities/ghost.md"))).toBe(false);
    },
    T,
  );

  test(
    "P97-04: fact without Source → after write contains [Source:",
    async () => {
      const rel = await captureNode(
        repoRoot,
        pack,
        queue,
        captureOpts({
          facts: [
            {
              text: "重试改为固定 3 次",
              event_type: "decision",
              attributed_to: "cli:test",
              at: "2026-01-01",
            },
          ],
        }),
      );
      const raw = await readFile(join(repoRoot, rel), "utf8");
      const { data } = parseFrontmatter(raw);
      const facts = data.facts as Array<{ text: string }>;
      expect(facts[0]!.text).toContain("[Source:");
      expect(facts[0]!.text).toContain(rel);
    },
    T,
  );

  test(
    "P97-05: fact already has [Source: → no double append",
    async () => {
      const rel = await captureNode(
        repoRoot,
        pack,
        queue,
        captureOpts({
          facts: [
            {
              text: "已签约 [Source: 会议纪要]",
              event_type: "decision",
              attributed_to: "cli:test",
              at: "2026-01-01",
            },
          ],
        }),
      );
      const raw = await readFile(join(repoRoot, rel), "utf8");
      const { data } = parseFrontmatter(raw);
      const text = (data.facts as Array<{ text: string }>)[0]!.text;
      expect(text.match(/\[Source:/g)?.length).toBe(1);
    },
    T,
  );

  test(
    "P97-06: entity write failure → main node queryable",
    async () => {
      const reg = createEntityRegistry(repoRoot, "default", queue);
      await reg.create({ slug: "alice", title: "Alice", createdBy: "cli:test" });

      const origWrite = nodeFs.writeFile;
      const writeSpy = spyOn(nodeFs, "writeFile").mockImplementation(async (path, ...args) => {
        const p = String(path).replace(/\\/g, "/");
        if (p.includes("/entities/alice.md")) {
          throw new Error("mock entity write fail");
        }
        return origWrite(path, ...args);
      });

      const rel = await captureNode(
        repoRoot,
        pack,
        queue,
        captureOpts({
          title: "Iron law fail-open",
          body: "网关超时 iron law fail-open 探针。",
          links: [{ to: "alice", type: "mentions", source: "frontmatter" }],
        }),
      );

      writeSpy.mockRestore();

      expect(existsSync(join(repoRoot, rel))).toBe(true);
      const hits = await query("fail-open");
      expect(hits.some((h) => h.path === rel)).toBe(true);
    },
    T,
  );

  test(
    "P97-07: iron_law.backlink false → no reverse links on entity",
    async () => {
      await patchMemoryYml(repoRoot, { iron_law: { backlink: false, source_suffix: true } });
      queue = await makeQueue();

      const reg = createEntityRegistry(repoRoot, "default", queue);
      await reg.create({ slug: "alice", title: "Alice", createdBy: "cli:test" });

      await captureNode(
        repoRoot,
        pack,
        queue,
        captureOpts({
          links: [{ to: "alice", type: "mentions", source: "frontmatter" }],
        }),
      );

      const aliceRaw = await readFile(join(repoRoot, "brains/default/entities/alice.md"), "utf8");
      const { data } = parseFrontmatter(aliceRaw);
      const links = data.links as Array<{ type: string }> | undefined;
      expect(links?.some((l) => l.type === "mentioned_in")).toBeFalsy();
    },
    T,
  );
});
