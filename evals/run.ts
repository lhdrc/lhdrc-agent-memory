/**
 * P5.6 评测入口。无参 / --mini 与 `bun run eval:mini` 同语义。
 */
import { parseEvalArgv, EVAL_HELP } from "./lib/argv.ts";
import { runMini } from "./mini.ts";
import { runDistill } from "./distill.ts";
import { runReport } from "./report.ts";
import { runFetch } from "./fetch.ts";
import { runAdapter } from "./adapter-run.ts";

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
  if (o.distill) return runDistill({ json: o.json });
  if (o.report) return runReport({ json: o.json });
  if (o.adapter) return runAdapter({ adapter: o.adapter, fixture: o.fixture, json: o.json });
  return runMini({ wipeIndex: o.wipeIndex, json: o.json });
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    process.exit(1);
  });
