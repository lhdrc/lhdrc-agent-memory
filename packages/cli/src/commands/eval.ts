import { join } from "node:path";
import { MemoryError, ErrorCodes } from "@df-memory/core";
import { parseArgs } from "../args.ts";

/** 定位 df-memory 仓库根（evals/run.ts），与当前记忆仓 cwd 无关。 */
function packageRoot(): string {
  return join(import.meta.dir, "../../../../");
}

export async function evalCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "mini", type: "boolean" },
    { name: "json", type: "boolean" },
    { name: "help", type: "boolean" },
  ]);
  if (o.help) {
    console.log("memory eval --mini [--json]\n\n跑仓内迷你评测（与 bun run eval:mini 同脚本）。");
    return 0;
  }
  if (!o.mini) {
    throw new MemoryError(ErrorCodes.USAGE, "eval 目前仅支持 --mini（完整评测见 P5.6）");
  }
  const root = packageRoot();
  const script = join(root, "evals", "run.ts");
  const proc = Bun.spawn({
    cmd: [process.execPath, script],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
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
    else console.log(exit === 0 ? "eval mini: ok" : "eval mini: failed");
  }
  if (err.trim()) console.error(err.trim());
  return exit;
}
