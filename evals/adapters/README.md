# 公开基准适配（P5.6 + P10.1）

实现 `EvalAdapter`（见 `types.ts`）。**禁止**空 README + `E_DISABLED` 算完成。

## locomo

| 项 | 值 |
|---|---|
| id | `locomo` |
| 格式 | LoCoMo JSON：`conversation.session_N[]` + `qa[]` |
| fixture | [`../fixtures/locomo-sample/`](../fixtures/locomo-sample/)（自建 1 样本 2 QA，**不是**全量下载） |
| full pin | `https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json`（`fetch --allow-net`） |
| 许可 | 全量数据遵循 [snap-research/locomo](https://github.com/snap-research/locomo) 上游许可；仓内 sample 为自建夹具 |
| JSON category | `1` multi-hop · `2` temporal · `3` open-domain · `4` single-hop · `5` adversarial（**不计分**） |

### `--fixture`（P5.6 CI）

子串命中：`captureNode` + `hybridQuery` + gold 是否出现在命中里。无网。**不能当对外数字。**

```bash
bun run evals/run.ts --adapter locomo --fixture
```

### Publish / J-score（P10.1）

每个 `session_N` → `compileSession` → 每题 `hybridQuery` + 答题 + LLM judge（CORRECT/WRONG）。只评 category 1–4。

```bash
bun run evals/run.ts fetch --adapter locomo --allow-net
bun run evals/run.ts --adapter locomo --sample <sample_id>
bun run evals/run.ts --adapter locomo
bun run evals/run.ts --adapter locomo --resume <run_id>
```

无 cache 且未给 `--sample` 时退出非 0，并提示使用 `--fixture` 或 `fetch --allow-net`。`--sample` 在未 fetch 时可对仓内 fixture 做 hermetic 预跑。

协议与评测前检查单：[`specs/十期/P10.1-locomo-publish.md`](../../specs/十期/P10.1-locomo-publish.md)。答题/judge prompt 锁在 [`locomo-prompts.ts`](./locomo-prompts.ts)。

## LongMemEval

未实现。需要时新增 adapter id + `fixtures/longmemeval-sample/`，不要用 stub 占位声称完成。

## halumem

| 项 | 值 |
|---|---|
| id | `halumem` |
| split | **Medium**（`HaluMem-Medium.jsonl`） |
| fixture | [`../fixtures/halumem-sample/`](../fixtures/halumem-sample/)（1 user / 1 session / 3 memory points / 2 QA） |
| full pin | [IAAR-Shanghai/HaluMem](https://huggingface.co/datasets/IAAR-Shanghai/HaluMem) `HaluMem-Medium.jsonl` |
| 协议 | `halumem-v1`：每 session `compileSession` → 规则 extract recall + QA J-score |

```bash
bun run evals/run.ts --adapter halumem --fixture
bun run evals/run.ts fetch --adapter halumem --allow-net
bun run evals/run.ts --adapter halumem --sample <uuid>   # 单 user 预跑
bun run evals/run.ts --adapter halumem --sample <uuid> --max-sessions 10  # 前 10 场趋势分
bun run evals/run.ts --adapter halumem --sample <uuid> --max-sessions 3 --ingest capture  # capture 原文摄入
bun run evals/run.ts --adapter halumem                   # 全量（需 fetch）
```

**extract 分项**（v1 规则子串，非 HaluMem 官方 LLM judge）：`integrity_recall`、`update_accuracy`；**QA** 与 LoCoMo 同 J-score 答题+judge。对外数字须声明口径差异。
