# 公开基准适配（P5.6）

实现 `EvalAdapter`（见 `types.ts`）。**禁止**空 README + `E_DISABLED` 算完成。

## locomo

| 项 | 值 |
|---|---|
| id | `locomo` |
| 格式 | LoCoMo JSON：`conversation.session_N[]` + `qa[]` |
| fixture | [`../fixtures/locomo-sample/`](../fixtures/locomo-sample/)（自建 1 样本 2 QA，**不是**全量下载） |
| full pin | `https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json`（`fetch --allow-net`） |
| 许可 | 全量数据遵循 [snap-research/locomo](https://github.com/snap-research/locomo) 上游许可；仓内 sample 为自建夹具 |

```bash
bun run evals/run.ts --adapter locomo --fixture
bun run evals/run.ts fetch --adapter locomo --allow-net
```

无 fixture 且未 fetch 时退出非 0，并提示使用 `--fixture` 或 `fetch --allow-net`。

## groupmembench

| 项 | 值 |
|---|---|
| id | `groupmembench` |
| 格式 | channel JSON（channel → messages）+ `questions/*.jsonl`（`id,question,answer,asking_user_id`） |
| fixture | [`../fixtures/groupmembench-sample/`](../fixtures/groupmembench-sample/)（自建 1 频道 2 QA） |
| full pin | GitHub `UCSB-NLP-Chang/GroupMemBench` Technology + `knowledge_update`（可用 `DF_EVAL_GMB_DOMAIN` / `DF_EVAL_GMB_QTYPE`） |
| 许可 | 全量遵循上游仓库；仓内 sample 为自建夹具 |

```bash
bun run evals/run.ts --adapter groupmembench --fixture
bun run evals/run.ts fetch --adapter groupmembench --allow-net
```

操作手册：[`../GROUPMEM_ORGMEM.md`](../GROUPMEM_ORGMEM.md)。**不要**把官方 gpt-5 judge 全量当本仓 CI。

## orgmembench

| 项 | 值 |
|---|---|
| id | `orgmembench` |
| 格式 | Helix `corpus_index.jsonl` + `corpus/**/*.md` + `benchmark_v0.0.jsonl` |
| fixture | [`../fixtures/orgmembench-sample/`](../fixtures/orgmembench-sample/)（自建 2 artifact 2 QA） |
| full pin | GitHub `JackCGardner/OrgMemBench` `datasets/helix/small` |
| 许可 | 全量 CC BY 4.0；仓内 sample 为自建夹具 |

```bash
bun run evals/run.ts --adapter orgmembench --fixture
bun run evals/run.ts fetch --adapter orgmembench --allow-net
```

## LongMemEval

未实现。需要时新增 adapter id + `fixtures/longmemeval-sample/`，不要用 stub 占位声称完成。
