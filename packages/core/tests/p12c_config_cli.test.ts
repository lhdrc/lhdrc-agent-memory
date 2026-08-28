/**
 * P12.3 memory config CLI
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initMemoryRepo } from "../src/index.ts";

const T = { timeout: 60_000 };
const bunBin = process.execPath;
const cliMain = join(import.meta.dir, "../../cli/src/main.ts");

function hermeticEnv(repoRoot: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, DF_MEMORY_ROOT: repoRoot };
  delete env.OPENAI_API_KEY;
  delete env.DF_MEMORY_MOCK_COMPLETE;
  delete env.DF_MEMORY_DATABASE_URL;
  return env;
}

async function runCli(
  repoRoot: string,
  args: string[],
): Promise<{ exit: number; out: string; err: string }> {
  const proc = Bun.spawn({
    cmd: [bunBin, cliMain, ...args],
    cwd: repoRoot,
    env: hermeticEnv(repoRoot),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, out: out.trim(), err: err.trim() };
}

describe("P12.3 memory config", () => {
  test("P12C-01 init 仓 config list --json 含 llm.off 与 embedding.openai", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p12c-01-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const r = await runCli(repoRoot, ["config", "list", "--json"]);
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(r.out) as { rows: Array<{ key: string; value: string }> };
    const llm = parsed.rows.find((x) => x.key === "llm.provider");
    const emb = parsed.rows.find((x) => x.key === "embedding.provider");
    expect(llm?.value).toBe("off");
    expect(emb?.value).toBe("openai");
  }, T);

  test("P12C-02 无 Key：doctor --json 非 ready 且退出 2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p12c-02-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const r = await runCli(repoRoot, ["config", "doctor", "--json"]);
    expect(r.exit).toBe(2);
    const parsed = JSON.parse(r.out) as {
      ok: boolean;
      rows: Array<{ key: string; ready: string }>;
    };
    const missing = parsed.rows.some((x) => x.ready === "missing_key");
    expect(parsed.ok === true && !missing).toBe(false);
    expect(missing || parsed.ok === false).toBe(true);
  }, T);

  test("P12C-03 set llm.provider=openai 写回；get 为 openai", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p12c-03-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const set = await runCli(repoRoot, ["config", "set", "llm.provider=openai"]);
    expect(set.exit).toBe(0);
    const yml = await readFile(join(repoRoot, "memory.yml"), "utf8");
    expect(yml).toMatch(/provider:\s*openai/);
    const get = await runCli(repoRoot, ["config", "get", "llm.provider"]);
    expect(get.exit).toBe(0);
    expect(get.out).toBe("openai");
  }, T);

  test("P12C-04 set llm.provider=bogus → E_USAGE", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p12c-04-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const r = await runCli(repoRoot, ["config", "set", "llm.provider=bogus"]);
    expect(r.exit).toBe(2);
    expect(`${r.out}\n${r.err}`).toContain("E_USAGE");
  }, T);

  test("P12C-05 拒绝把密钥写入 yml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p12c-05-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const a = await runCli(repoRoot, ["config", "set", "openai_api_key=sk-xxxxxxxx"]);
    expect(a.exit).toBe(2);
    expect(`${a.out}\n${a.err}`).toContain("E_USAGE");
    const b = await runCli(repoRoot, ["config", "set", "llm.openai_api_key=sk-xxxxxxxx"]);
    expect(b.exit).toBe(2);
    expect(`${b.out}\n${b.err}`).toContain("E_USAGE");
    const yml = await readFile(join(repoRoot, "memory.yml"), "utf8");
    expect(yml).not.toContain("sk-xxxxxxxx");
  }, T);

  test("P12C-06 list effect 写明 remember 须 llm.provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p12c-06-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const r = await runCli(repoRoot, ["config", "list", "--json"]);
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(r.out) as { rows: Array<{ key: string; effect: string }> };
    const llm = parsed.rows.find((x) => x.key === "llm.provider");
    expect(llm?.effect.toLowerCase()).toMatch(/remember/);
    expect(llm?.effect).toMatch(/llm\.provider/);
  }, T);

  test("P12C-07 help 含 config doctor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p12c-07-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const r = await runCli(repoRoot, ["help"]);
    expect(r.exit).toBe(0);
    expect(r.out).toMatch(/config doctor/);
  }, T);
});
