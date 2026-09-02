/**
 * evals/run.ts argv。与 `memory eval` 转发的 flag 对齐。
 */
export const EVAL_HELP = `bun run evals/run.ts --mini|--distill|--report|--adapter <id> [--fixture] [--json]
bun run evals/run.ts fetch --adapter <id> --allow-net

仓内评测默认无网。公开全量需 fetch --allow-net。
已支持 adapter: locomo, groupmembench, orgmembench。
--adapter 默认流水线: ingest(有 Key 则 compileSession) → dream(3,4) → hybrid query。
  DF_EVAL_INGEST=capture 强制不调 LLM；DF_EVAL_FULL=0 可关闭 dream。
`;

export interface EvalArgv {
  _: string[];
  help: boolean;
  mini: boolean;
  distill: boolean;
  report: boolean;
  adapter?: string;
  fixture: boolean;
  json: boolean;
  allowNet: boolean;
  wipeIndex: boolean;
  fixtureExperiences: boolean;
}

export function parseEvalArgv(argv: string[]): EvalArgv {
  const o: EvalArgv = {
    _: [],
    help: false,
    mini: false,
    distill: false,
    report: false,
    fixture: false,
    json: false,
    allowNet: false,
    wipeIndex: false,
    fixtureExperiences: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--mini") o.mini = true;
    else if (a === "--distill") o.distill = true;
    else if (a === "--report") o.report = true;
    else if (a === "--fixture") o.fixture = true;
    else if (a === "--json") o.json = true;
    else if (a === "--allow-net") o.allowNet = true;
    else if (a === "--wipe-index") o.wipeIndex = true;
    else if (a === "--fixture-experiences") o.fixtureExperiences = true;
    else if (a === "--adapter") {
      o.adapter = argv[++i];
    } else if (a.startsWith("--adapter=")) {
      o.adapter = a.slice("--adapter=".length);
    } else if (!a.startsWith("-")) {
      o._.push(a);
    }
  }
  return o;
}
