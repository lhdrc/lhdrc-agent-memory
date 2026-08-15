import { join } from "node:path";
import { MemoryError, ErrorCodes } from "@lhdrc/core";
import { parseArgs } from "../args.ts";

/** 定位 df-memory 仓库根（evals/run.ts），与当前记忆仓 cwd 无关。 */
function packageRoot(): string {
  return join(import.meta.dir, "../../../../");
}

const HELP = `memory eval --mini|--distill|--report|--adapter <id> [--fixture] [--json]
memory eval fetch --adapter <id> --allow-net

跑仓内评测（与 bun run eval:mini / eval:distill / eval:report 同脚本）。
无网默认用 --fixture；全量公开基准需 fetch --allow-net。
`;

export async function evalCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "mini", type: "boolean" },
    { name: "distill", type: "boolean" },
    { name: "report", type: "boolean" },
    { name: "adapter", type: "string" },
    { name: "fixture", type: "boolean" },
    { name: "json", type: "boolean" },
    { name: "allow-net", type: "boolean" },
    { name: "wipe-index", type: "boolean" },
    { name: "help", type: "boolean" },
  ]);
  if (o.help) {
    console.log(HELP);
    return 0;
  }
  const isFetch = o._[0] === "fetch";
  if (!isFetch && !o.mini && !o.distill && !o.report && !o.adapter) {
    throw new MemoryError(
      ErrorCodes.USAGE,
      "eval 需要 --mini | --distill | --report | --adapter <id> | fetch（完整评测见 P5.6）",
    );
  }
  const forward: string[] = [];
  if (isFetch) forward.push("fetch");
  if (o.mini) forward.push("--mini");
  if (o.distill) forward.push("--distill");
  if (o.report) forward.push("--report");
  if (o.adapter) forward.push("--adapter", String(o.adapter));
  if (o.fixture) forward.push("--fixture");
  if (o.json) forward.push("--json");
  if (o["allow-net"]) forward.push("--allow-net");
  if (o["wipe-index"]) forward.push("--wipe-index");

  const root = packageRoot();
  const script = join(root, "evals", "run.ts");
  const proc = Bun.spawn({
    cmd: [process.execPath, script, ...forward],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const stdout = out.trim();
  if (o.json) {
    const summary = stdout || JSON.stringify({ ok: exit === 0, exit });
    console.log(summary);
  } else {
    if (stdout) console.log(stdout);
    else console.log(exit === 0 ? "eval: ok" : "eval: failed");
  }
  if (err.trim()) console.error(err.trim());
  return exit;
}
