/**
 * P5.6 评测入口。无参 / --mini 与 `bun run eval:mini` 同语义。
 */
import { existsSync, readFileSync } from "node:fs";
import { parseEvalArgv, EVAL_HELP } from "./lib/argv.ts";
import { runMini } from "./mini.ts";
import { runDistill } from "./distill.ts";
import { runReport } from "./report.ts";
import { runFetch } from "./fetch.ts";
import { runAdapter } from "./adapter-run.ts";

/** 仓库根 .env（不入库）优先于 shell 已设变量；仅填充未定义的 key。 */
function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  const txt = readFileSync(path, "utf8");
  for (const raw of txt.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const o = parseEvalArgv(argv);
  if (o.help) {
    console.log(EVAL_HELP);
    return 0;
  }
  if (o._[0] === "fetch") {
    return runFetch({ adapter: o.adapter, allowNet: o.allowNet });
  }
  const modes = [o.mini, o.distill, o.report, Boolean(o.adapter)].filter(Boolean).length;
  if (modes > 1) {
    console.error("请只指定一种模式: --mini | --distill | --report | --adapter <id>");
    return 1;
  }
  if (o.distill) return runDistill({ json: o.json, fixtureExperiences: o.fixtureExperiences });
  if (o.report) return runReport({ json: o.json });
  if (o.adapter)
    return runAdapter({
      adapter: o.adapter,
      fixture: o.fixture,
      json: o.json,
      sample: o.sample,
      resume: o.resume,
      runId: o.runId,
      allowHashEmbed: o.allowHashEmbed,
      ingest: o.ingest,
      concurrency: o.concurrency,
      maxSessions: o.maxSessions,
      continueOnCompileError: o.continueOnCompileError,
    });
  return runMini({ wipeIndex: o.wipeIndex, json: o.json });
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    process.exit(1);
  });
