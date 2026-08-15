import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hereDir, loadPack, packageRootFrom, readSchemaSql } from "../src/index.ts";

const SRC_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../src");
const CORE_ROOT = join(SRC_ROOT, "..");
const REPO_ROOT = join(CORE_ROOT, "../..");

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walkTs(abs, out);
    else if (name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

function runNode(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("node", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}

function runNpmPackDryRun(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["pack", "--dry-run"], {
      cwd: CORE_ROOT,
      windowsHide: true,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}

describe("P4.2 Node 兼容与可发布 core", () => {
  test("P42-01 core src 生产路径无 Bun 专有 API", () => {
    const files = walkTs(SRC_ROOT);
    expect(files.length).toBeGreaterThan(10);
    const banned = [/Bun\.file\b/, /Bun\.spawn\b/, /import\.meta\.dir\b/];
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const re of banned) {
        if (re.test(text)) hits.push(`${f.replace(SRC_ROOT, "src")}: ${re}`);
      }
    }
    expect(hits).toEqual([]);
  });

  test("P42-03/04 schema.sql 与 problem-tree pack 可从封装读到", async () => {
    const sql = await readSchemaSql(import.meta.url);
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS pages");
    const pack = await loadPack("problem-tree");
    expect(pack.id).toBe("problem-tree");
    expect(pack.schema_types.length).toBeGreaterThan(0);
    expect(packageRootFrom(import.meta.url)).toContain("core");
  });

  test(
    "P42-05 Node 可 import 构建入口并读到 schema.sql",
    async () => {
      const build = Bun.spawn({
        cmd: ["bun", "run", "build:core"],
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      const buildCode = await build.exited;
      expect(buildCode).toBe(0);
      const distEntry = join(CORE_ROOT, "dist", "index.js");
      expect(existsSync(distEntry)).toBe(true);
      expect(existsSync(join(CORE_ROOT, "dist", "schema.sql"))).toBe(true);

      const tmp = await mkdtemp(join(tmpdir(), "dfmem-p42-"));
      const script = join(tmp, "smoke.mjs");
      await Bun.write(
        script,
        `import { hereDir, readSchemaSql } from ${JSON.stringify(pathToFileURL(distEntry).href)};
const sql = await readSchemaSql();
if (!sql.includes("CREATE TABLE")) throw new Error("schema.sql empty");
const dir = hereDir(import.meta.url);
if (!dir) throw new Error("hereDir empty");
console.log("ok", sql.length);
`,
      );
      const r = await runNode([script], tmp);
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("ok");
    },
    { timeout: 120_000 },
  );

  test(
    "P42-06 npm pack 含 schema.sql 与 schema-packs",
    async () => {
      const r = await runNpmPackDryRun();
      const text = `${r.stdout}\n${r.stderr}`;
      expect(r.exitCode).toBe(0);
      expect(text).toMatch(/schema\.sql/);
      expect(text).toMatch(/schema-packs/);
    },
    { timeout: 60_000 },
  );
});
