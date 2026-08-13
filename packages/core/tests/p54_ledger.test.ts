/**
 * P5.4 Event Ledger / link-facts / forget --purge
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  issueToken,
  sha256Token,
  gitLog,
  openPglite,
  parseFrontmatter,
} from "../src/index.ts";

let dir: string;
let repoRoot: string;

const T = { timeout: 120_000 };
const bunBin = process.execPath;
const cliMain = join(import.meta.dir, "../../cli/src/main.ts");

async function runCli(
  args: string[],
  opts?: { env?: Record<string, string> },
): Promise<{ exit: number; out: string; err: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DF_MEMORY_ROOT: repoRoot,
    ...opts?.env,
  };
  if (!opts?.env?.DF_MEMORY_TOKEN) delete env.DF_MEMORY_TOKEN;
  const proc = Bun.spawn({
    cmd: [bunBin, cliMain, ...args],
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, out: out.trim(), err: err.trim() };
}

async function capturePath(title: string): Promise<string> {
  const cap = await runCli([
    "capture",
    "--title",
    title,
    "--type",
    "note",
    "--body",
    `${title} body`,
    "--json",
  ]);
  expect(cap.exit).toBe(0);
  return (JSON.parse(cap.out) as { path: string }).path;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-p54-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
});

describe("P5.4 ledger / link-facts / purge", () => {
  test(
    "P54-01: 空 brain events list --json → {events:[]}",
    async () => {
      const r = await runCli(["events", "list", "--json"]);
      expect(r.exit).toBe(0);
      expect(JSON.parse(r.out)).toEqual({ events: [] });
    },
    T,
  );

  test(
    "P54-02: events append 后 list 能查到",
    async () => {
      const a = await runCli([
        "events",
        "append",
        "--type",
        "note",
        "--payload-json",
        JSON.stringify({ k: 1 }),
        "--json",
      ]);
      expect(a.exit).toBe(0);
      const created = JSON.parse(a.out) as { id: string; type: string };
      expect(created.type).toBe("note");

      const list = await runCli(["events", "list", "--type", "note", "--json"]);
      expect(list.exit).toBe(0);
      const parsed = JSON.parse(list.out) as { events: Array<{ id: string; type: string }> };
      expect(parsed.events.some((e) => e.id === created.id && e.type === "note")).toBe(true);
    },
    T,
  );

  test(
    "P54-03: entity merge 写入 entity_merged",
    async () => {
      expect((await runCli(["entity", "create", "--slug", "alice", "--title", "Alice"])).exit).toBe(0);
      expect((await runCli(["entity", "create", "--slug", "bob", "--title", "Bob"])).exit).toBe(0);
      const m = await runCli(["entity", "merge", "alice", "bob", "--canonical", "alice", "--confirm"]);
      expect(m.exit).toBe(0);

      const list = await runCli(["events", "list", "--type", "entity_merged", "--json"]);
      expect(list.exit).toBe(0);
      const parsed = JSON.parse(list.out) as { events: unknown[] };
      expect(parsed.events.length).toBeGreaterThan(0);
    },
    T,
  );

  test(
    "P54-04: soft forget 文件仍在且 node_archived",
    async () => {
      const path = await capturePath("软删笔记");
      const f = await runCli(["forget", path]);
      expect(f.exit).toBe(0);
      expect(existsSync(join(repoRoot, path))).toBe(true);
      const { data } = parseFrontmatter(await readFile(join(repoRoot, path), "utf8"));
      expect(data.status).toBe("archived");

      const list = await runCli(["events", "list", "--type", "node_archived", "--json"]);
      expect(list.exit).toBe(0);
      const parsed = JSON.parse(list.out) as { events: Array<{ type: string; from?: unknown }> };
      expect(parsed.events.some((e) => e.type === "node_archived")).toBe(true);
    },
    T,
  );

  test(
    "P54-05: link-facts 写入 entity md + fact_linked；rebuild 后实体仍在",
    async () => {
      expect((await runCli(["entity", "create", "--slug", "alice", "--title", "Alice"])).exit).toBe(0);
      const linked = await runCli(["entity", "link-facts", "alice", "--fact", "已签约", "--json"]);
      expect(linked.exit).toBe(0);
      const entityRel = join(repoRoot, "brains", "default", "entities", "alice.md");
      const raw = await readFile(entityRel, "utf8");
      expect(raw).toContain("已签约");

      const list = await runCli(["events", "list", "--type", "fact_linked", "--json"]);
      expect(list.exit).toBe(0);
      const parsed = JSON.parse(list.out) as { events: Array<{ type: string }> };
      expect(parsed.events.some((e) => e.type === "fact_linked")).toBe(true);

      const rb = await runCli(["rebuild-index"]);
      expect(rb.exit).toBe(0);
      const conn = await openPglite(repoRoot);
      try {
        const rows = await conn.db.query<{ slug: string }>(
          `SELECT slug FROM entity_registry WHERE brain_id = $1 AND slug = $2`,
          ["default", "alice"],
        );
        expect(rows.rows.length).toBe(1);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P54-06: --purge 无 --confirm → E_USAGE，文件仍在",
    async () => {
      const path = await capturePath("待确认硬删");
      const f = await runCli(["forget", path, "--purge"]);
      expect(f.exit).toBe(2);
      expect(f.err).toContain("E_USAGE");
      expect(f.err).toMatch(/--confirm/);
      expect(existsSync(join(repoRoot, path))).toBe(true);
    },
    T,
  );

  test(
    "P54-07: --purge --confirm 删除文件 + node_purged；read E_NOT_FOUND",
    async () => {
      const path = await capturePath("硬删笔记");
      const f = await runCli(["forget", path, "--purge", "--confirm"]);
      expect(f.exit).toBe(0);
      expect(existsSync(join(repoRoot, path))).toBe(false);

      const read = await runCli(["read", path]);
      expect(read.exit).toBe(2);
      expect(read.err).toContain("E_NOT_FOUND");

      const list = await runCli(["events", "list", "--type", "node_purged", "--json"]);
      expect(list.exit).toBe(0);
      const parsed = JSON.parse(list.out) as { events: Array<{ type: string }> };
      expect(parsed.events.some((e) => e.type === "node_purged")).toBe(true);
    },
    T,
  );

  test(
    "P54-08: git.mode=batch 时 purge 独立 force commit",
    async () => {
      const path = await capturePath("账本硬删");
      const before = await gitLog(repoRoot, 5);
      const f = await runCli(["forget", path, "--purge", "--confirm"]);
      expect(f.exit).toBe(0);
      const after = await gitLog(repoRoot, 5);
      expect(after[0]).toMatch(/purge/i);
      expect(after[0]).toMatch(/^memory:/);
      expect(after[0]).not.toBe(before[0]);
    },
    T,
  );

  test(
    "P54-09: reader token forget --purge --confirm → E_FORBIDDEN",
    async () => {
      const path = await capturePath("鉴权硬删");
      const issued = issueToken("reader1", "default");
      const ymlPath = join(repoRoot, "memory.yml");
      let yml = await readFile(ymlPath, "utf8");
      yml += `
auth:
  users:
    - id: reader1
      role: reader
      brains:
        default:
          role: reader
          sources: ["*"]
  tokens:
    - id: ${issued.id}
      user: reader1
      hash: "sha256:${sha256Token(issued.raw)}"
      brain: default
`;
      await writeFile(ymlPath, yml, "utf8");

      const f = await runCli(["forget", path, "--purge", "--confirm"], {
        env: { DF_MEMORY_TOKEN: issued.raw },
      });
      expect(f.exit).toBe(2);
      expect(f.err).toContain("E_FORBIDDEN");
      expect(existsSync(join(repoRoot, path))).toBe(true);
    },
    T,
  );

  test(
    "P54-10: soft 与 purge 事件类型可过滤",
    async () => {
      const softPath = await capturePath("对照软删");
      const hardPath = await capturePath("对照硬删");
      expect((await runCli(["forget", softPath])).exit).toBe(0);
      expect((await runCli(["forget", hardPath, "--purge", "--confirm"])).exit).toBe(0);

      const archived = JSON.parse((await runCli(["events", "list", "--type", "node_archived", "--json"])).out) as {
        events: Array<{ type: string }>;
      };
      const purged = JSON.parse((await runCli(["events", "list", "--type", "node_purged", "--json"])).out) as {
        events: Array<{ type: string }>;
      };
      expect(archived.events.length).toBeGreaterThan(0);
      expect(purged.events.length).toBeGreaterThan(0);
      expect(archived.events.every((e) => e.type === "node_archived")).toBe(true);
      expect(purged.events.every((e) => e.type === "node_purged")).toBe(true);
    },
    T,
  );

  test("HELP 含 events / link-facts / purge", async () => {
    const r = await runCli(["--help"]);
    expect(r.exit).toBe(0);
    expect(r.out).toContain("events");
    expect(r.out).toContain("link-facts");
    expect(r.out).toContain("purge");
    expect(r.out).toMatch(/不可默认|不可自动化/);
  });
});
