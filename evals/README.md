# evals — df-memory 评测（P5.6）

Hermetic 评测：默认无网。公开全量仅 `fetch --allow-net`。  
评测临时仓在检测到 `OPENCODE_API_KEY` 时会把 LLM 指到 [OpenCode Go](https://opencode.ai/docs/go/)（详见 [`GROUPMEM_ORGMEM.md`](GROUPMEM_ORGMEM.md) §5）。Go 无 embeddings。

## 如何跑

```bash
bun run eval:mini          # 检索回归 + 隔离；写出 evals/receipts/
bun run eval:distill       # 有经验 vs 无经验（规则代理）
bun run eval:report        # 打印最近 receipt metrics
bun run eval:locomo-sample # LoCoMo 仓内 fixture 子集
bun run eval:groupmembench-sample
bun run eval:orgmembench-sample
bun test packages/core/tests/isolation_fuzz.test.ts
```

CLI 同语义：

```bash
memory eval --mini
memory eval --distill
memory eval --report
memory eval --adapter locomo --fixture
memory eval fetch --adapter locomo --allow-net
memory eval --adapter groupmembench --fixture
memory eval --adapter orgmembench --fixture
```

GroupMemBench / OrgMemBench 启动步骤见 [`GROUPMEM_ORGMEM.md`](GROUPMEM_ORGMEM.md)。  
`--adapter` 默认 **ingest → dream(蒸馏+矛盾) → query**（可用 `DF_EVAL_FULL=0` 退回仅检索）。全量评测不要当 CI。

检索门禁：`bun run evals/run.ts --mini --wipe-index` 应非 0（清空索引且不 rebuild）。

## 目录

| 路径 | 说明 |
|---|---|
| `fixtures/mini/` | 12 条检索夹具 + 隔离 secret（运行时注入） |
| `fixtures/distill/` | 有/无经验对比 |
| `fixtures/locomo-sample/` | LoCoMo JSON 形状的仓内小样（非全量） |
| `fixtures/groupmembench-sample/` | GroupMemBench 形状自建小样 |
| `fixtures/orgmembench-sample/` | OrgMemBench 形状自建小样 |
| `adapters/` | `EvalAdapter`：`locomo` / `groupmembench` / `orgmembench` |
| `receipts/` | per-run receipt（gitignore；保留 .gitkeep） |
| `cache/` | `fetch --allow-net` 产物（gitignore） |

单仓多 brain 时 git 历史对同仓可见，非密码学隔离。
