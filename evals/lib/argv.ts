export interface EvalArgv {
  _: string[];
  mini: boolean;
  distill: boolean;
  report: boolean;
  fixture: boolean;
  json: boolean;
  help: boolean;
  wipeIndex: boolean;
  allowNet: boolean;
  adapter?: string;
}

export function parseEvalArgv(argv: string[]): EvalArgv {
  const out: EvalArgv = {
    _: [],
    mini: false,
    distill: false,
    report: false,
    fixture: false,
    json: false,
    help: false,
    wipeIndex: false,
    allowNet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--mini") out.mini = true;
    else if (a === "--distill") out.distill = true;
    else if (a === "--report") out.report = true;
    else if (a === "--fixture") out.fixture = true;
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--wipe-index") out.wipeIndex = true;
    else if (a === "--allow-net") out.allowNet = true;
    else if (a === "--adapter" || a.startsWith("--adapter=")) {
      const v = a.startsWith("--adapter=") ? a.slice("--adapter=".length) : argv[++i];
      if (v) out.adapter = v;
    } else if (a.startsWith("--")) {
      throw new Error(`未知参数: ${a}`);
    } else {
      out._.push(a);
    }
  }
  if (process.env.DF_EVAL_WIPE_INDEX === "1") out.wipeIndex = true;
  return out;
}

export const EVAL_HELP = `df-memory evals (P5.6)

  bun run eval:mini
  bun run eval:distill
  bun run eval:report
  bun run evals/run.ts --adapter locomo --fixture
  bun run evals/run.ts fetch --adapter locomo --allow-net

Flags:
  --mini --distill --report --adapter <id> --fixture --json
  --wipe-index   清空索引且不 rebuild（检索门禁；应失败）
  --allow-net    允许 fetch 公开基准
`;
