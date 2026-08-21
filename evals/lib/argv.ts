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
  fixtureExperiences: boolean;
  adapter?: string;
  sample?: string;
  resume?: string;
  runId?: string;
  allowHashEmbed: boolean;
  ingest?: "compile" | "capture";
  concurrency?: number;
  maxSessions?: number;
  topK?: number;
  /** halumem-official-v1 | halumem-v1（内部 LoCoMo J-score 趋势） */
  protocol?: string;
  /** 单场 compile 失败时继续（默认 max_sessions 预跑开启） */
  continueOnCompileError?: boolean;
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
    fixtureExperiences: false,
    allowHashEmbed: false,
    ingest: "compile",
    concurrency: 1,
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
    else if (a === "--fixture-experiences") out.fixtureExperiences = true;
    else if (a === "--adapter" || a.startsWith("--adapter=")) {
      const v = a.startsWith("--adapter=") ? a.slice("--adapter=".length) : argv[++i];
      if (v) out.adapter = v;
    } else if (a === "--sample" || a.startsWith("--sample=")) {
      const v = a.startsWith("--sample=") ? a.slice("--sample=".length) : argv[++i];
      if (v) out.sample = v;
    } else if (a === "--resume" || a.startsWith("--resume=")) {
      const v = a.startsWith("--resume=") ? a.slice("--resume=".length) : argv[++i];
      if (v) out.resume = v;
    } else if (a === "--run-id" || a.startsWith("--run-id=")) {
      const v = a.startsWith("--run-id=") ? a.slice("--run-id=".length) : argv[++i];
      if (v) out.runId = v;
    } else if (a === "--allow-hash-embed") out.allowHashEmbed = true;
    else if (a === "--ingest" || a.startsWith("--ingest=")) {
      const v = a.startsWith("--ingest=") ? a.slice("--ingest=".length) : argv[++i];
      if (v === "compile" || v === "capture") out.ingest = v;
      else throw new Error(`--ingest 仅支持 compile | capture，收到: ${v}`);
    } else if (a === "--concurrency" || a.startsWith("--concurrency=")) {
      const v = a.startsWith("--concurrency=") ? a.slice("--concurrency=".length) : argv[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--concurrency 需为正整数，收到: ${v}`);
      out.concurrency = n;
    } else if (a === "--max-sessions" || a.startsWith("--max-sessions=")) {
      const v = a.startsWith("--max-sessions=") ? a.slice("--max-sessions=".length) : argv[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--max-sessions 需为正整数，收到: ${v}`);
      out.maxSessions = n;
    } else if (a === "--top-k" || a.startsWith("--top-k=")) {
      const v = a.startsWith("--top-k=") ? a.slice("--top-k=".length) : argv[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--top-k 需为正整数，收到: ${v}`);
      out.topK = n;
    } else if (a === "--protocol" || a.startsWith("--protocol=")) {
      const v = a.startsWith("--protocol=") ? a.slice("--protocol=".length) : argv[++i];
      if (v) out.protocol = v;
    } else if (a === "--continue-on-compile-error") {
      out.continueOnCompileError = true;
    } else if (a === "--no-continue-on-compile-error") {
      out.continueOnCompileError = false;
    }
    else if (a.startsWith("--")) {
      throw new Error(`未知参数: ${a}`);
    } else {
      out._.push(a);
    }
  }
  if (process.env.DF_EVAL_WIPE_INDEX === "1") out.wipeIndex = true;
  return out;
}

export const EVAL_HELP = `df-memory evals (P5.6 + P10.1)

  bun run eval:mini
  bun run eval:distill
  bun run eval:report
  bun run evals/run.ts --adapter locomo --fixture
  bun run evals/run.ts fetch --adapter locomo --allow-net
  bun run evals/run.ts --adapter locomo --sample <id>
  bun run evals/run.ts --adapter locomo

Flags:
  --mini --distill --report --adapter <id> --fixture --json
  --sample <id>          LoCoMo publish 预跑一个 sample_id（J-score）
  --resume <run_id>      跳过已 qa_done 的 sample
  --run-id <id>          指定 run_id（默认同时间戳）
  --allow-hash-embed     允许 embedding 降级哈希（禁止当对外主分）
  --ingest <mode>         locomo 摄入入口：compile（默认，走提取合同）| capture（raw 原文，绕过提取过滤）
  --concurrency <n>       locomo QA 阶段并发数（默认 1，串行）；注意 API 速率/额度
  --max-sessions <n>      halumem 每 user 最多 compile 前 N 场（趋势预跑；QA 仅含已 compile 场）
  --top-k <n>             halumem QA 检索 top_k（official 默认 20；halumem-v1 默认 5）
  --protocol <id>         halumem：halumem-official-v1（默认）| halumem-v1（内部 LoCoMo J-score）
  --continue-on-compile-error  halumem 单场 compile 失败仍继续（max_sessions 预跑默认开启）
  --fixture-experiences  distill 对照：仍写入工经验（默认关，走 refineSource）
  --wipe-index   清空索引且不 rebuild（检索门禁；应失败）
  --allow-net    允许 fetch 公开基准
`;
